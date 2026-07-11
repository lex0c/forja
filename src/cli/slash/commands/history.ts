// /history — manage the REPL input history table (HISTORY.md §2.3).
//
// Subcommands:
//   /history             — summary line: count + cap + UX hints.
//   /history list        — last 20 entries, oldest-first within block.
//   /history clear       — modal confirm (Yes / Yes-and-disable / No);
//                          --yes flag skips the modal for automation.
//   /history off         — session-volatile disable. submits posterior
//                          to this command don't write to disk.
//   /history on          — re-enable for this session.
//
// All branches are scoped to the current project_root (baseConfig.cwd)
// — the storage layer and the in-memory mirror in repl.ts agree on
// that key, so cross-project entries can never bleed in.
//
// Permanent opt-outs (`FORJA_NO_HISTORY=1` env, `.forja/no-history`
// file marker) are checked downstream of this command — `appendHistory`
// / `loadHistory` no-op in the storage layer regardless of what
// `/history on` says, and we surface that asymmetry to the operator
// via the summary so a misconfigured env doesn't look like a bug.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDirName } from '../../../config/app-namespace.ts';
import { clearHistory, countHistory, HISTORY_CAP, loadHistory } from '../../../storage/history.ts';
import type { SlashCommand, SlashContext } from '../types.ts';

const LIST_LIMIT = 20;

// Collapse multi-line prompts to a single visual row for the list
// output. Same approach the reverse-search overlay takes: history
// listings should never grow the scrollback unpredictably.
const collapseToOneLine = (s: string): string => {
  const trimmed = s.replace(/\r?\n/g, ' ').trim();
  // Cap so a 2KB prompt doesn't turn into a 2KB line that hogs the
  // terminal — `/history list` is a glance tool, not full content
  // recall (operator has ↑/Ctrl+R for that).
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
};

const summary = (ctx: SlashContext): string => {
  const count = countHistory(ctx.db, ctx.baseConfig.cwd);
  const enabled = ctx.history?.isEnabled() ?? true;
  const persistedHint = enabled
    ? '/history list to view, /history clear to wipe'
    : 'persistence is OFF for this session — /history on to re-enable';
  return `${count} entries · cap ${HISTORY_CAP} · ${persistedHint}`;
};

const handleList = async (ctx: SlashContext): Promise<string[]> => {
  const entries = loadHistory(ctx.db, ctx.baseConfig.cwd, LIST_LIMIT);
  if (entries.length === 0) {
    return ['no history entries for this project'];
  }
  // loadHistory returns oldest-first; we want oldest-first within the
  // displayed block so the operator's eye reads top-to-bottom in the
  // direction time flowed. Timestamps would be nicer per spec
  // (`<ts shortform> · <prompt>`) but storage exposes only the prompt
  // strings via the public API — adding a `loadHistoryWithTs` would
  // double the surface for one command. Lean on the recency hint
  // operators get from the `(oldest first)` header instead.
  const lines: string[] = [`recent history (oldest first, max ${LIST_LIMIT}):`];
  for (const prompt of entries) {
    lines.push(`  ${collapseToOneLine(prompt)}`);
  }
  return lines;
};

const wipe = (ctx: SlashContext, alsoDisable: boolean): string[] => {
  clearHistory(ctx.db, ctx.baseConfig.cwd);
  ctx.history?.clearLocal();
  const notes = ['history cleared'];
  if (alsoDisable) {
    // Permanent per-project opt-out (HISTORY.md §3.3 level 2).
    // `mkdir -p .forja` in case bootstrap hasn't created it yet
    // (early projects; rare). The marker is empty — its existence
    // alone is the signal storage checks.
    const agentDir = join(ctx.baseConfig.cwd, projectDirName());
    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'no-history'), '');
      notes.push('persistence disabled — .forja/no-history written');
      // Mirror in-session: the file marker disables persistence
      // even if the operator later runs `/history on`, so we flip
      // the session flag too for consistency between what they
      // see in the summary and what storage will accept.
      ctx.history?.setEnabled(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`warning: could not write .forja/no-history (${msg})`);
    }
  }
  return notes;
};

const handleClear = async (args: string[], ctx: SlashContext): Promise<string[]> => {
  const count = countHistory(ctx.db, ctx.baseConfig.cwd);
  if (count === 0) {
    return ['nothing to clear'];
  }
  // `--yes` (or `-y`) skips the modal — automation path. Spec §2.3
  // calls this out explicitly. Kept simple: positional args, no
  // optional flag parser.
  const skipModal = args.some((a) => a === '--yes' || a === '-y');
  if (skipModal) {
    return wipe(ctx, false);
  }
  // Interactive: launch the confirm modal. The modal-manager owns
  // the focus + queue; we await its answer and branch on the value.
  const answer = await ctx.modalManager.askHistoryClear({
    entryCount: count,
    projectRoot: ctx.baseConfig.cwd,
  });
  if (answer === 'yes') return wipe(ctx, false);
  if (answer === 'yes-disable') return wipe(ctx, true);
  // 'no' / 'cancel' — operator opted out. Return a small breadcrumb
  // so they see the command terminated (matching the `/clear`-style
  // visible feedback every other modal-using command does).
  return ['cancelled — history left intact'];
};

const handleOff = (ctx: SlashContext): string[] => {
  if (ctx.history === undefined) {
    return ['/history off: not available in this context'];
  }
  ctx.history.setEnabled(false);
  return ['history persistence: off (this session only — /history on to re-enable)'];
};

const handleOn = (ctx: SlashContext): string[] => {
  if (ctx.history === undefined) {
    return ['/history on: not available in this context'];
  }
  // Refuse no-op re-enable when the storage layer would still drop
  // every write. Surfacing "persistence: on" here while storage
  // keeps no-opping would be a lie that gets discovered only after
  // the operator re-opens the REPL and finds nothing recalled.
  const reason = ctx.history.optOutReason();
  if (reason === 'env') {
    return [
      '/history on refused — FORJA_NO_HISTORY=1 is set in env',
      'unset the env var and restart the REPL to re-enable persistence',
    ];
  }
  if (reason === 'file-marker') {
    return [
      '/history on refused — .forja/no-history marker is present',
      'remove .forja/no-history and run /history on again to re-enable',
    ];
  }
  ctx.history.setEnabled(true);
  return ['history persistence: on'];
};

export const historyCommand: SlashCommand = {
  name: 'history',
  description: 'manage REPL input history (list/clear/off/on)',
  argHint: 'list|clear|off|on',
  exec: async (args, ctx) => {
    const sub = args[0];
    if (sub === undefined) {
      return { kind: 'ok', notes: [summary(ctx)] };
    }
    switch (sub) {
      case 'list': {
        const lines = await handleList(ctx);
        return { kind: 'ok', notes: lines };
      }
      case 'clear': {
        const lines = await handleClear(args.slice(1), ctx);
        return { kind: 'ok', notes: lines };
      }
      case 'off':
        return { kind: 'ok', notes: handleOff(ctx) };
      case 'on':
        return { kind: 'ok', notes: handleOn(ctx) };
      default:
        return {
          kind: 'error',
          message: `/history: unknown subcommand '${sub}' (try: list, clear, off, on)`,
        };
    }
  },
};
