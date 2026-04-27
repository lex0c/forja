import { migration001Initial } from './001-initial.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [migration001Initial];
