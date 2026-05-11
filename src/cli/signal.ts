// Wires SIGINT + SIGTERM to an AbortController.
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
// Returns a `restore` function to remove BOTH listeners — important
// for long-lived test processes that wire/unwire many controllers.
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
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  return () => {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  };
};
