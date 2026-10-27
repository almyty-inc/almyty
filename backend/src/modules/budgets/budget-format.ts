/**
 * Money and shares of a budget, in words people read in an alert. A
 * budget can be a cent and a model call a fraction of one, so an amount
 * under a dollar keeps up to four decimals ($0.0042) and a share above
 * nothing never reads as 0% ("<1%"), nor 100% before the limit is reached.
 */

/** Decimals kept for an amount under a dollar ($0.0042). */
const SMALL_AMOUNT_DECIMALS = 4;

/** `cents` (fractions allowed) as dollars: $12.50, $0.01, $0.0042, $0.00. */
export function formatSpendCents(cents: number): string {
  const dollars = (Number.isFinite(cents) ? cents : 0) / 100;
  if (Math.abs(dollars) >= 1 || dollars === 0) return `$${dollars.toFixed(2)}`;
  const fixed = dollars.toFixed(SMALL_AMOUNT_DECIMALS).replace(/0+$/, '');
  const [whole, frac = ''] = fixed.split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

/** The share of `limitCents` spent, without the % sign: "<1", "80", "100". */
export function formatSpendShare(spentCents: number, limitCents: number): string {
  if (!(limitCents > 0)) return '0';
  const share = (spentCents / limitCents) * 100;
  if (spentCents > 0 && share < 1) return '<1';
  // Below the limit it never rounds up to 100.
  return String(share < 100 ? Math.floor(share) : Math.round(share));
}
