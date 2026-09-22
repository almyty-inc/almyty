/**
 * The one translation from a compliance policy's PII categories to the
 * settings the built-in pii-filter actually reads.
 *
 * `compliance_policies.piiCategories` was written by the settings page,
 * stored, and reported back under `enforcedControls[].settings.categories`
 * — and read by nothing that masks anything. The enforcement hook handed
 * the pii-filter `{}`, so the plugin ran on its registered defaults and
 * masked all five categories whatever the four checkboxes said. The report
 * then told the operator the narrowed set was the enforced one, which is
 * the part that makes it a compliance bug rather than a dead field.
 *
 * Both the hook and the report go through this function so the two can
 * never again describe different behaviour.
 */

/** Category id (what the API and the settings page speak) to plugin setting. */
export const PII_CATEGORY_SETTINGS: Record<string, string> = {
  email: 'detectEmails',
  phone: 'detectPhoneNumbers',
  ssn: 'detectSSN',
  credit_card: 'detectCreditCards',
  ip: 'detectIPAddresses',
};

/**
 * An empty list means every category, matching what the report has always
 * displayed ('all'). A non-empty list is exhaustive: categories left out
 * are switched OFF, because a category list that can only add is not a
 * choice the operator made.
 *
 * An unknown category is ignored rather than rejected here; the controller
 * validates input, and a policy row written by an older build must not
 * break the pipeline.
 */
export function piiCategoriesToSettings(categories: string[] | null | undefined): Record<string, boolean> {
  const selected = (categories ?? []).filter((c) => c in PII_CATEGORY_SETTINGS);
  if (selected.length === 0) return {};

  const wanted = new Set(selected.map((c) => PII_CATEGORY_SETTINGS[c]));
  const settings: Record<string, boolean> = {};
  for (const setting of Object.values(PII_CATEGORY_SETTINGS)) {
    settings[setting] = wanted.has(setting);
  }
  return settings;
}
