import { migration001Initial } from './001-initial.ts';
import { migration002Approvals } from './002-approvals.ts';
import { migration003UsageCost } from './003-usage-cost.ts';
import { migration004SessionUsageComplete } from './004-session-usage-complete.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  migration001Initial,
  migration002Approvals,
  migration003UsageCost,
  migration004SessionUsageComplete,
];
