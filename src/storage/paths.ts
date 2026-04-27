import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultDataDir = (): string => {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg !== undefined && xdg.length > 0
    ? join(xdg, 'forja')
    : join(homedir(), '.local', 'share', 'forja');
};

export const defaultDbPath = (): string => join(defaultDataDir(), 'sessions.db');
