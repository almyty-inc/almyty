import { MEMORY_CONNECTORS } from '../../connections/connector-catalog';
import { memoryAccountName } from './memory-accounts.service';

/**
 * What a memory service said, as a sentence a person can act on.
 *
 * Services answer in their own shapes (`{"detail":"Invalid API key. ..."}`,
 * `provider rejected the credential (401: unauthorized)`, a socket error).
 * None of that is shown on a page: the page gets one plain sentence naming
 * the service and what to do; the raw answer goes to the log and the audit
 * row only.
 */
export function plainServiceError(service: string, raw: unknown): string {
  const name = service === 'almyty-native' ? 'almyty' : memoryAccountName(service);
  const text = String((raw as any)?.message ?? raw ?? '');
  if (!text) return `${name} did not answer as expected.`;
  if (/invalid api key|api key is (invalid|required)|unauthori[sz]ed|forbidden|rejected the credential|authenticat|\b40[13]\b|invalid[_ ]token|permission denied|missing apikey/i.test(text)) {
    const where = keyPageHost(service);
    return where ? `${name} refused the key. Check it at ${where}.` : `${name} refused the key. Check it on the account's page under Credentials.`;
  }
  if (/\b429\b|rate.?limit|too many requests|quota|credit|billing|insufficient/i.test(text)) {
    return `${name} is over its usage limit. Try again later, or check the plan at ${keyPageHost(service) ?? 'the service'}.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|connection refused|timed? ?out|fetch failed|socket hang up|network|busy/i.test(text)) {
    return `${name} could not be reached. Try again in a few minutes.`;
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(text)) {
    return `${name} had a problem on its side. Try again later.`;
  }
  if (/\b404\b|not found/i.test(text)) {
    return `${name} could not find what almyty asked for. Check the account's settings under Credentials.`;
  }
  return `${name} did not accept the request. Check the account under Credentials.`;
}

/** Where a service's keys are managed, as a host name ("app.mem0.ai"). */
function keyPageHost(service: string): string | null {
  const url = MEMORY_CONNECTORS.find((c) => c.key === service)?.keyPageUrl;
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
