import type { ManagedBy } from '../credentials/credential-ref.resolver';
import {
  CHANNEL_CREDENTIAL_KEYS,
  normalizeChannelConfigKeys,
  splitChannelConfigSecrets,
} from '../gateways/channels/channel-config.helper';

/**
 * A channel's platform keys live in `credentials`, never on the row.
 *
 * Keys typed on the channel form go into one credential the channel
 * manages; a key picked from Credentials is referenced as it is. Either
 * way the configuration keeps only `credentialId` and `credentialKeys`
 * (names, never values), the same shape a channel gateway keeps, so
 * publishing hands the gateway a reference rather than a copy.
 */

/** The consumer identity of a channel's managed credential row. */
export function channelManagedBy(channelId: string): ManagedBy {
  return { kind: 'agent_channel', id: channelId };
}

/** Keys of the configuration the server owns; a client never sets them directly. */
const SERVER_OWNED_KEYS = ['credentialId', 'credentialKeys', 'connectionId'];

export interface ChannelSecretSplit {
  /** Typed secret values, keyed by their canonical snake_case name. */
  secrets: Record<string, string>;
  /** Secret keys the caller sent empty: "clear this". */
  cleared: string[];
  /** Everything else, safe to keep on the row. */
  publicConfig: Record<string, any>;
}

/**
 * Separate what an operator sent into the secrets that belong in the
 * store, the secrets they asked to clear, and the configuration that may
 * stay on the channel. A masked placeholder sent back is neither.
 */
export function splitChannelSecrets(configuration: Record<string, any> | null | undefined): ChannelSecretSplit {
  const { secrets, publicConfig } = splitChannelConfigSecrets(configuration);
  const normalized = normalizeChannelConfigKeys(configuration);
  const cleared = CHANNEL_CREDENTIAL_KEYS.filter((key) => normalized[key] === '' || normalized[key] === null);
  for (const key of SERVER_OWNED_KEYS) delete publicConfig[key];
  return { secrets, cleared, publicConfig };
}
