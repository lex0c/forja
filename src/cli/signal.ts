// Wires SIGINT to an AbortController. First Ctrl+C requests graceful abort
// (the harness exits as 'interrupted'); a second Ctrl+C escalates to a
// hard process.exit(130) so the user can always get out.
//
// Returns a `restore` function to remove the listener — important for
// long-lived test processes that wire/unwire many controllers.
export const installSignalHandler = (controller: AbortController): (() => void) => {
  let pressed = 0;
  const handler = (): void => {
    pressed += 1;
    if (pressed === 1) {
      process.stderr.write('\nforja: interrupting (press Ctrl+C again to force quit)\n');
      controller.abort();
      return;
    }
    process.stderr.write('forja: forced quit\n');
    process.exit(130);
  };
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
};
