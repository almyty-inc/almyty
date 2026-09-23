import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A deployment's declared privacy tier reaches the card the router gates
 * with.
 *
 * `ModelDeploymentDesired.privacyTier` had a select in the deploy dialog,
 * a row in the deployment detail sheet, a field on the adapter-facing
 * DeploymentDesired, and no reader: not one of the thirteen deployment
 * adapters touches it, and ModelRouter gates on `card.privacyTier`, which
 * model-catalog sets on its own (ollama -> 'local', everything else ->
 * 'public') or by hand in the edit-model sheet. So a model deployed into
 * a private VPC still carried 'public' and a private_cloud routing policy
 * refused it, while the dialog showed the tier the user had chosen.
 *
 * `desired.region` on the line above in fillCard had the identical write
 * path and WAS propagated, which is what makes this an omission rather
 * than a design.
 *
 * Textual, because the real seam is one assignment inside a reconcile
 * step whose behavioural test would have to stand up the whole processor
 * -- and a behavioural test of fillCard would pass just as happily
 * against the version that drops the field, which is how it survived.
 */
describe('deployment privacy tier reaches the routing card', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

  const fillCard = () => {
    const source = src('modules/model-deployments/model-deployments.processor.ts');
    const at = source.indexOf('private async fillCard(');
    expect(at).toBeGreaterThan(-1); // update this guard if fillCard moved
    return source.slice(at, at + 3000);
  };

  it('fillCard writes desired.privacyTier onto the card', () => {
    expect(fillCard()).toMatch(/card\.privacyTier\s*=\s*d\.desired\.privacyTier/);
  });

  it('it sits with the region propagation it mirrors', () => {
    // If region ever stops being propagated here, this whole pairing is
    // being redesigned and the comment above the assignment is stale.
    const body = fillCard();
    expect(body).toContain('card.region = actual.region ?? d.desired.region');
    expect(body.indexOf('card.privacyTier')).toBeGreaterThan(body.indexOf('card.region'));
  });

  it('the router still gates on the card field this feeds', () => {
    // The other half of the wire. A router that stopped reading
    // card.privacyTier would make the assignment above pointless again.
    expect(src('modules/model-catalog/routing/model-router.ts')).toContain('card.privacyTier');
  });
});
