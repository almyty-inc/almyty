import { CredentialType } from '../../entities/credential.entity';

/**
 * The inline `api.authentication` shape (`{ type, config }`) split into
 * what goes to the credential store and what stays on the API row.
 * Shared by ApisService (writes) and the startup backfill.
 */
export interface InlineApiAuth {
  type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
  config: Record<string, any>;
}

export interface SplitInlineApiAuth {
  credentialType: CredentialType;
  /** Secret fields, named as the Credential entity encrypts them. */
  secretConfig: Record<string, string>;
  /** Everything else, kept on the API row next to the credential reference. */
  publicConfig: Record<string, any>;
  keyName: string | null;
  keyLocation: string | null;
}

const SECRET_KEYS_BY_TYPE: Record<string, string[]> = {
  bearer: ['token'],
  basic: ['password'],
  // The api_key shape was never canonicalised (apiKey / value / key); every spelling is read.
  api_key: ['apiKey', 'value', 'key'],
  oauth2: ['accessToken', 'refreshToken', 'clientSecret', 'client_secret'],
};

const CREDENTIAL_TYPE_BY_AUTH: Record<string, CredentialType> = {
  bearer: CredentialType.BEARER_TOKEN,
  basic: CredentialType.BASIC_AUTH,
  api_key: CredentialType.API_KEY,
  oauth2: CredentialType.OAUTH2,
};

/** True when the inline config still carries a secret value. */
export function hasInlineApiSecret(auth: InlineApiAuth | null | undefined): boolean {
  if (!auth || auth.type === 'none' || !auth.config) return false;
  return (SECRET_KEYS_BY_TYPE[auth.type] ?? []).some((k) => typeof auth.config[k] === 'string' && auth.config[k].length > 0);
}

/** Split the inline auth; null when there is nothing secret to move. */
export function splitInlineApiAuth(auth: InlineApiAuth | null | undefined): SplitInlineApiAuth | null {
  if (!hasInlineApiSecret(auth)) return null;
  const config = { ...auth!.config };
  const secretConfig: Record<string, string> = {};
  for (const key of SECRET_KEYS_BY_TYPE[auth!.type]) {
    const value = config[key];
    if (typeof value === 'string' && value.length > 0) {
      // api_key spellings collapse onto `apiKey`; oauth2 snake_case onto camelCase.
      const canonical = auth!.type === 'api_key' ? 'apiKey' : key === 'client_secret' ? 'clientSecret' : key;
      if (!secretConfig[canonical]) secretConfig[canonical] = value;
    }
    delete config[key];
  }
  if (auth!.type === 'basic' && typeof config.username === 'string') {
    secretConfig.username = config.username;
  }
  const keyName = auth!.type === 'api_key' ? (config.headerName || config.parameter || config.name || null) : null;
  const keyLocation = auth!.type === 'api_key' ? (config.location || 'header') : null;
  return {
    credentialType: CREDENTIAL_TYPE_BY_AUTH[auth!.type],
    secretConfig,
    publicConfig: config,
    keyName,
    keyLocation,
  };
}

/**
 * Rebuild the inline shape the request builders read
 * (ApisToolGeneratorHelper.applyAuthentication) from the API row's
 * public config plus a resolved credential config.
 */
export function inlineApiAuthView(auth: InlineApiAuth, resolvedConfig: Record<string, any>): InlineApiAuth {
  const config: Record<string, any> = { ...auth.config };
  delete config.credentialId;
  switch (auth.type) {
    case 'bearer':
      config.token = resolvedConfig.token;
      break;
    case 'basic':
      config.username = resolvedConfig.username ?? config.username;
      config.password = resolvedConfig.password;
      break;
    case 'api_key':
      config.value = resolvedConfig.apiKey;
      config.apiKey = resolvedConfig.apiKey;
      config.name = config.name || config.headerName || config.parameter;
      config.location = config.location || 'header';
      break;
    case 'oauth2':
      config.accessToken = resolvedConfig.accessToken;
      break;
  }
  return { type: auth.type, config };
}
