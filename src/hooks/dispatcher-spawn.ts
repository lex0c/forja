// Spawn signature the dispatcher uses. Returns an interface
// the dispatcher drives: write stdin, kill, await exit.
export interface DispatchedProcess {
  stdin: { write: (chunk: string) => void; end: () => void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  // Promise resolves when the process exits. `kill(signal)` sends
  // the signal; the resulting exit may take more time. Caller
  // is responsible for the SIGTERM → 1s → SIGKILL ladder.
  exited: Promise<number>;
  kill: (signal?: 'SIGTERM' | 'SIGKILL') => void;
}

export interface SpawnOpts {
  env: Record<string, string>;
  cwd: string;
  stdin: 'pipe';
  stdout: 'pipe';
  stderr: 'pipe';
}

export type SpawnFn = (cmd: string[], opts: SpawnOpts) => DispatchedProcess;

export const defaultSpawn: SpawnFn = (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    env: opts.env,
    cwd: opts.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdin: {
      write: (chunk) => {
        proc.stdin.write(chunk);
      },
      end: () => {
        proc.stdin.end();
      },
    },
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: (signal) => {
      proc.kill(signal);
    },
  };
};
