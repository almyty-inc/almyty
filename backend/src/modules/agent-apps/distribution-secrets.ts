import type { ManagedBy } from '../credentials/credential-ref.resolver';
import {
  CHANNEL_CREDENTIAL_KEYS,
  normalizeChannelConfigKeys,
  splitChannelConfigSecrets,
} from '../gateways/channels/channel-config.helper';

/**
 * A distribution's platform secrets live in `credentials`, never on the row.
 *
 * The bot token, signing secret or Twilio auth token an operator pastes
 * into a distribution used to be stored as they arrived, in plain JSON on
 * `agent_app_distributions.configuration`, and handed back on every read
 * of the app, members included. Now they go into one credential row the
 * distribution manages; the configuration keeps only `credentialId` and
 * `credentialKeys` (names, never values), the same shape a channel gateway
 * keeps, so publishing hands the gateway a reference rather than a copy.
 */

/** The consumer identity of a distribution's managed credential row. */
export function distributionManagedBy(distributionId: string): ManagedBy {
  return { kind: 'app_distribution', id: distributionId };
}

/** Keys of the configuration the server owns; a client never sets them. */
const SERVER_OWNED_KEYS = ['credentialId', 'credentialKeys', 'connectionId'];

export interface DistributionSecretSplit {
  /** Pasted secret values, keyed by their canonical snake_case name. */
  secrets: Record<string, string>;
  /** Secret keys the caller sent empty: "clear this". */
  cleared: string[];
  /** Everything else, safe to keep on the row. */
  publicConfig: Record<string, any>;
}

/**
 * Separate what an operator sent into the secrets that belong in the
 * store, the secrets they asked to clear, and the configuration that may
 * stay on the distribution. A masked placeholder sent back is neither.
 */
export function splitDistributionSecrets(configuration: Record<string, any> | null | undefined): DistributionSecretSplit {
  const { secrets, publicConfig } = splitChannelConfigSecrets(configuration);
  const normalized = normalizeChannelConfigKeys(configuration);
  const cleared = CHANNEL_CREDENTIAL_KEYS.filter((key) => normalized[key] === '' || normalized[key] === null);
  for (const key of SERVER_OWNED_KEYS) delete publicConfig[key];
  return { secrets, cleared, publicConfig };
}
