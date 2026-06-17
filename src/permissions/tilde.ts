// Single source of truth for `~` expansion across the permission layer.
// Shells expand `~` on execution, so the engine has to too or a resolved
// capability would lie about what the tool actually touches. This used to be
// copy-pasted in three places (resolvers/fs.ts, resolvers/bash.ts, config.ts);
// the duplication is exactly the divergence risk this codebase keeps closing —
// one copy could be "fixed" while another silently drifts. Keep it here, once.
//
// Two shapes expand:
//   - bare `'~'`        → `home`
//   - `'~/<rest>'`      → `<home>/<rest>`
//
// `'~user/...'` (other-user expansion) stays LITERAL: there is no safe way to
// resolve another user's home without an OS call, and an agent authoring
// `~root/...` is far more likely an attack than a legitimate path. The literal
// form lands somewhere harmless or outside the operator's policy, surfacing a
// deny — fail-closed by construction.
export const expandTilde = (path: string, home: string): string => {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  return path;
};
