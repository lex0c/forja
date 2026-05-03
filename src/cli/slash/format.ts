// Shared formatters for slash command output.
//
// Cost format degrades with magnitude (4 decimals < $1, 3 < $100,
// 2 ≥ $100) — same shape as the footer's right column for a
// consistent reading experience across every place the operator
// sees a dollar figure.

export const formatCost = (usd: number): string => {
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
};

export const formatMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
};
