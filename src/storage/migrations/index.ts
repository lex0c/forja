import { migration001Initial } from './001-initial.ts';
import { migration002Approvals } from './002-approvals.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [migration001Initial, migration002Approvals];
