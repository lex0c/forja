// The memory subsystem's atomic-write needs are a subset of the shared
// fs primitive, so re-export it — one implementation, one set of
// guarantees, no memory-local copy to drift. The previous local copy
// lacked fsync, mode preservation, and symlink following: harmless for
// memory files (plain markdown/JSON, never executable or symlinked) but
// a footgun if reused, so it's gone. See src/fs/atomic-write.ts.
export { atomicWrite } from '../fs/atomic-write.ts';
