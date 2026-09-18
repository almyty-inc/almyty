import { readFileSync } from 'fs';
import { join } from 'path';
import { A2A_PROTOCOL_VERSION } from '../types/a2a-spec.types';

/**
 * Gateway.entity.ts advertises an `a2aVersion` in its public config. It is a
 * plain literal, because an entity must not import a module, and it sat at
 * '0.3.0' while the module moved to v1.0 — so the gateway told callers one
 * version and the agent card told them another. Nothing caught it, because
 * the entity's own spec only exercises an explicitly-configured value and
 * never the default. This pins the two together.
 */
describe('the gateway entity advertises the version the module speaks', () => {
  it('uses A2A_PROTOCOL_VERSION as its a2aVersion default', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'entities', 'gateway.entity.ts'),
      'utf8',
    );
    const match = source.match(/a2aVersion:\s*this\.configuration\.a2aVersion\s*\|\|\s*'([^']+)'/);
    // If this is null the default moved or changed shape; fix the regex, do
    // not delete the assertion.
    expect(match).not.toBeNull();
    expect(match![1]).toBe(A2A_PROTOCOL_VERSION);
  });
});
