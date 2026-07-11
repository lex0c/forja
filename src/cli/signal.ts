// Wires SIGINT / SIGTERM / SIGHUP / SIGQUIT to an AbortController,
// plus uncaughtException + unhandledRejection — every path that
// could terminate the harness now feeds the controller so cleanup
// (broker.close, db.close, bgManager.cleanup) runs deterministically.
//
// SIGINT (Ctrl+C): first press requests graceful abort (the harness
// exits as 'interrupted'); a second press escalates to a hard
// process.exit(130) so the user can always get out.
//
// SIGTERM (slice 86): operator/init/systemd signaled stop. Aborts
// the controller for a graceful drain — the run.ts / repl.ts
// finally blocks close the broker (PERMISSION_ENGINE.md §13.7)
// and the DB. No escalation on second SIGTERM: a sender that
// wants force-quit follows up with SIGKILL, which we can't
// intercept anyway.
//
// SIGHUP (slice 148, BG2): terminal closed, controlling tty lost,
// or a service manager signalled hangup. Pre-slice the harness
// ignored it; the runtime received SIGHUP from the kernel, exited
// without trapping, and bg children spawned by the LLM became
// PID-1 orphans. Now treated as graceful abort, same shape as
// SIGTERM — the finally chain runs bgManager.cleanup() which
// SIGTERMs every live bg job before the parent dies.
//
// SIGQUIT (slice 148, BG2): rarely sent by users (Ctrl+\) but
// service managers do send it for "quit immediately + dump core".
// We don't dump core; we drain. Same shape as SIGHUP.
//
// uncaughtException / unhandledRejection (slice 148, BG2): an
// unexpected throw in the harness loop bypasses every finally
// block — Node would default-exit and bg processes would orphan.
// Listen, log to stderr, abort the controller, then process.exit(1).
// We re-throw nothing; the abort gives finally chains one tick to
// run before the exit takes effect.
export const installSignalHandler = (controller: AbortController): (() => void) => {
  let sigintPressed = 0;
  const sigintHandler = (): void => {
    sigintPressed += 1;
    if (sigintPressed === 1) {
      process.stderr.write('\nforja: interrupting (press Ctrl+C again to force quit)\n');
      controller.abort();
      return;
    }
    process.stderr.write('forja: forced quit\n');
    process.exit(130);
  };
  const sigtermHandler = (): void => {
    process.stderr.write('\nforja: received SIGTERM, shutting down gracefully\n');
    controller.abort();
  };
  // Slice 148 (BG2): SIGHUP / SIGQUIT also abort. Same posture as
  // SIGTERM — the finally chain handles cleanup. The message tag
  // differs per signal so operators can correlate logs with the
  // upstream signaling tool.
  const sighupHandler = (): void => {
    process.stderr.write('\nforja: received SIGHUP, shutting down gracefully\n');
    controller.abort();
  };
  const sigquitHandler = (): void => {
    process.stderr.write('\nforja: received SIGQUIT, shutting down gracefully\n');
    controller.abort();
  };
  // Slice 148 (BG2): catch-all for the "throw escaped every layer"
  // case. Abort, log, then exit. process.exit(1) is delayed by a
  // microtask so the finally chains observing controller.signal
  // get a tick to start their cleanup. They may not complete (the
  // process is dying); the bg manager's per-spawn `detached: true`
  // ensures `--die-with-parent`-style PG reaping if cleanup never
  // gets to issue the explicit SIGTERMs.
  const uncaughtHandler = (err: unknown): void => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`\nforja: uncaught exception, shutting down: ${msg}\n`);
    controller.abort();
    queueMicrotask(() => process.exit(1));
  };
  const rejectionHandler = (reason: unknown): void => {
    const msg =
      reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
    process.stderr.write(`\nforja: unhandled rejection, shutting down: ${msg}\n`);
    controller.abort();
    queueMicrotask(() => process.exit(1));
  };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGHUP', sighupHandler);
  process.on('SIGQUIT', sigquitHandler);
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', rejectionHandler);

  return () => {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGHUP', sighupHandler);
    process.off('SIGQUIT', sigquitHandler);
    process.off('uncaughtException', uncaughtHandler);
    process.off('unhandledRejection', rejectionHandler);
  };
};
