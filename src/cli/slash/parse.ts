// Slash input parser. Spec: UI.md §5.3.
//
// Detects whether an input buffer is a slash invocation, and if so
// splits it into `{name, args[]}`. Pure function — no IO, no
// registry lookup. The dispatcher takes the parse result and looks
// the name up in the registry.
//
// Rules:
//   - Must start with `/` (after optional leading whitespace? NO —
//     leading whitespace means it's not a slash invocation, just
//     normal input. Models sometimes prefix with whitespace.).
//   - Empty after `/` → not a command (e.g., user typed just `/`
//     and is mid-typing). Returns null so the autocomplete UI can
//     still show all commands.
//   - Bare `/` returns `{name: '', args: []}` so the caller can
//     show all commands (autocomplete).
//   - Args are split on runs of whitespace; leading/trailing trimmed.
//   - Quoted args NOT supported in v1 (spec doesn't call for them);
//     when a command needs spaces in an arg (`/sessions filter foo bar`),
//     it joins args[] back. Document in the command.

export interface ParsedSlash {
  // Command name without leading slash. Empty string when the user
  // typed bare `/` — autocomplete shows all commands in that case.
  name: string;
  // Positional args, lowercase whitespace-split. Empty array when
  // no args.
  args: string[];
}

export const parseSlashInput = (input: string): ParsedSlash | null => {
  // Slash MUST be the first character. Leading whitespace = normal
  // user message that happens to mention `/foo` later.
  if (input.length === 0 || input[0] !== '/') return null;
  const body = input.slice(1).trim();
  if (body.length === 0) return { name: '', args: [] };
  // Split on runs of whitespace. The name is the first token; args
  // are the remainder. We do NOT lowercase — commands use lowercase
  // names by convention (registry lookup is case-sensitive), but
  // some args (paths, IDs) are case-significant.
  const parts = body.split(/\s+/);
  const name = parts[0] ?? '';
  const args = parts.slice(1);
  return { name, args };
};
