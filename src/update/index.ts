// Update subsystem: the passive "update available" notice (SECURITY_GUIDELINE
// §11.4). Pure semver + a synchronous cache-read decision + an async,
// fail-silent network refresh. The `forja update` pull-side command (§11.1–3)
// will reuse the semver + resolve pieces here when implemented.

export type { UpdateNotice } from './boot.ts';
export { isCiEnv, kickUpdateRefresh, markNoticeShown, peekUpdateNotice } from './boot.ts';
export type { NoticeDecision } from './notice.ts';
export { DEFAULT_INTERVAL_MS, decideNotice, shouldRefresh } from './notice.ts';
export type { InstallOrigin } from './origin.ts';
export { detectInstallOrigin, updateCommand } from './origin.ts';
export {
  fetchLatestVersion,
  RELEASES_LATEST_URL,
  refreshUpdateCache,
} from './refresh.ts';
export type { Semver } from './semver.ts';
export { compareSemver, formatSemver, isNewer, parseSemver } from './semver.ts';
