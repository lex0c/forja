// Claim-time verification gate (STATE_MACHINE §3.2.1). Pure, deterministic
// helpers the loop folds in at `no_tool_use`: track whether the run mutated a
// file and which declared verify-commands have passed (exit 0) SINCE the last
// mutation, then decide whether to block a tool-call-free final answer and nudge
// the model to verify. 100% deterministic — real mutation tracking + bash exit
// codes + operator-declared commands, never model prose (the failure that got
// the regex-over-prose ProjectVerifier removed).
import { FILE_WRITER_TOOLS } from '../tools/file-writer-tools.ts';

// Only a FOREGROUND bash exit code is trusted as "the verify command ran";
// bash_background has no settled exit code at finish.
const FOREGROUND_BASH = 'bash';

// Bound on verify-gate re-entries per completion (STATE_MACHINE §3.2.1). After
// this many nudges the gate accepts the answer (it is a nudge, not a hard trap).
export const MAX_VERIFY_ATTEMPTS = 2;

export interface VerifyState {
  // The run made ≥1 successful file write.
  everMutated: boolean;
  // Declared commands seen passing (exit 0) since the LAST mutation. Cleared on
  // each new mutation, so a command only counts if it post-dates the last edit.
  verifiedSinceLastMutation: Set<string>;
}

export const createVerifyState = (): VerifyState => ({
  everMutated: false,
  verifiedSinceLastMutation: new Set(),
});

// Whitespace-only normalization (NOT command-pattern matching — the gate is a
// UX nudge, not the permission engine; it makes no allow/deny decision).
const collapseWs = (s: string): string => s.trim().split(/\s+/).join(' ');

// True when `bashCommand` actually RAN `declared` (the exit-0 check is the
// caller's): WHOLE-command equality only — the ws-collapsed bash command must
// equal the declared command in full. No segment splitting, because matching a
// declared command as a SEGMENT of a one-liner is unsound two ways:
//   1. The bash tool reports ONE overall exit code, so a masking operator
//      (`bun test || true`, `bun test; true`, `bun test | cat`) would credit a
//      command whose failure was swallowed or which never ran.
//   2. A textual split can't tell a real shell `&&` from one inside a quoted
//      string / heredoc / comment, so `echo "x && bun test && y"` (exit 0)
//      would credit `bun test` though it never executed.
// As the whole command, the declared command's exit code IS the tool's exit
// code — unambiguous, with no shell parsing at all (this stays a pure module,
// not a dependant of the bash tokenizer). The cost is that the model must run
// the declared command verbatim: an operator who needs a prefix or wrapper
// declares that exact string (`cd app && bun test`, `CI=1 bun test`), the nudge
// names it, and the model runs it as-is. Operates on the structured `command`
// tool arg, never on model prose.
export const matchesVerifyCommand = (bashCommand: string, declared: string): boolean => {
  const target = collapseWs(declared);
  if (target.length === 0) return false;
  return collapseWs(bashCommand) === target;
};

// Fold one settled tool call into the verify state. A successful file write
// marks the run mutated and INVALIDATES prior verify evidence (the edit
// post-dates it). A foreground bash exiting 0 that runs a declared command
// records that command as verified-since-the-last-mutation. No-op when the gate
// is off (no declared commands).
//
// Returns TRUE iff this call recorded a fresh mutation that RE-ARMS the gate (a
// new edit starts a new verification cycle). The caller resets the per-cycle
// nudge budget on a re-arm so a later edit isn't starved of nudges by attempts
// spent on an earlier one.
//
// KNOWN BLIND SPOT: only the structured writers in FILE_WRITER_TOOLS count as a
// mutation. A file edited THROUGH bash (`sed -i`, `> file`, `git apply`, `tee`)
// is not tracked (bash's write path is unknowable from its input — same reason
// recap files it under commands_run, not filesWritten), so the gate won't fire
// for a bash-only edit. Detecting bash writes deterministically isn't feasible
// without prose/command heuristics (the ProjectVerifier failure this design
// avoids); the encouraged edit path is the structured tools, which ARE covered.
export const recordToolForVerify = (
  state: VerifyState,
  commands: readonly string[],
  toolName: string,
  input: Record<string, unknown> | undefined,
  failed: boolean,
  // The tool's NON-ZERO exit code, or `undefined` for a zero exit / no exit.
  // The loop passes `invokeTool`'s `inv.exitCode`, which is undefined on a zero
  // exit (`readNonZeroExit`), so a foreground bash that EXITED 0 is exactly
  // `!failed && nonZeroExit === undefined`; a non-zero exit carries the code.
  nonZeroExit: number | undefined,
): boolean => {
  if (commands.length === 0) return false;
  if (!failed && FILE_WRITER_TOOLS.has(toolName)) {
    state.everMutated = true;
    state.verifiedSinceLastMutation.clear();
    return true;
  }
  // A foreground bash that ran and exited 0 (no tool error, no non-zero code)
  // AND ran at the DEFAULT cwd. An explicit cwd override is not credited: the
  // declared command is matched as a whole string with no notion of directory,
  // so `bun test` run in a subpackage (cwd: "packages/foo") would accept a
  // narrower suite than the operator's root-level `bun test`. A directory
  // requirement must live IN the command (`cd packages/foo && bun test`) so it
  // becomes part of the matched evidence; a bare command counts only at default.
  if (
    toolName === FOREGROUND_BASH &&
    !failed &&
    nonZeroExit === undefined &&
    input?.cwd === undefined
  ) {
    const command = typeof input?.command === 'string' ? input.command : '';
    for (const declared of commands) {
      if (matchesVerifyCommand(command, declared)) state.verifiedSinceLastMutation.add(declared);
    }
  }
  return false;
};

// The declared commands NOT yet verified since the last mutation — the gate's
// trigger. Empty when the gate is off (no commands) or the run never mutated a
// file (nothing to verify) or all commands already passed.
export const unsatisfiedVerifyCommands = (
  state: VerifyState,
  commands: readonly string[],
): string[] => {
  if (commands.length === 0 || !state.everMutated) return [];
  return commands.filter((c) => !state.verifiedSinceLastMutation.has(c));
};

// The synthetic user nudge naming the unsatisfied commands. Nudge-only — the
// MODEL runs them (gated by permissions); the harness never auto-executes.
export const verifyGateNudge = (unsatisfied: readonly string[]): string => {
  const list = unsatisfied.map((c) => `\`${c}\``).join(', ');
  const one = unsatisfied.length === 1;
  return `You edited files but have not shown ${one ? 'this command' : 'these commands'} passing yet: ${list}. Before giving your final answer, run ${one ? 'it' : 'them'} now — each must exit 0. If a command fails, fix the code and re-run; do not claim done until the verification passes.`;
};
