// Re-export shim. The canonical home for the SENSITIVE_PATH_DENY_LIST
// and matchSensitivePath moved to `src/permissions/sensitive-paths.ts`
// in slice 159 when the permission engine became a consumer (engine-
// floor refuse on the fs-tool path). This shim keeps the original
// import path working — `src/subagents/worktree-validation.ts` and any
// other subagent-side caller need no edit.
//
// Future cleanup may remove this shim entirely once all importers
// move to the permissions path. Keeping it for now so the slice 159
// surface is minimal.

export { matchSensitivePath, SENSITIVE_PATH_DENY_LIST } from '../permissions/sensitive-paths.ts';
