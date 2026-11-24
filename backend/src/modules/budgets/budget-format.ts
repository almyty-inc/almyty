/**
 * Money and shares of a budget, in words people read in an alert. An
 * amount reads as every cost does ($12.50, "<$0.01" for a fraction of a
 * cent), and a share above nothing never reads as 0% ("<1%"), nor 100%
 * before the limit is reached.
 */
import { formatCostCents } from '../../common/utils/format';

/** `cents` (fractions allowed) as dollars: $12.50, $0.01, <$0.01, $0.00. */
export function formatSpendCents(cents: number): string {
  return formatCostCents(cents, { empty: '$0.00' });
}

/** The share of `limitCents` spent, without the % sign: "<1", "80", "100". */
export function formatSpendShare(spentCents: number, limitCents: number): string {
  if (!(limitCents > 0)) return '0';
  const share = (spentCents / limitCents) * 100;
  if (spentCents > 0 && share < 1) return '<1';
  // Below the limit it never rounds up to 100.
  return String(share < 100 ? Math.floor(share) : Math.round(share));
}
