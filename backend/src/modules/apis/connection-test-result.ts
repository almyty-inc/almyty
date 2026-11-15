/**
 * What "Test connection" on an API says, in plain words.
 *
 * The test asks the API's address itself. Most APIs serve only their own
 * paths and answer 404, 400 or 401 on the bare address; that answer still
 * proves the host is up and reachable, so only a server error or no answer
 * at all is a failed test. Open-Meteo answers its root with 400 and was
 * shown as a red "Failed" next to a raw `{"success":false,"statusCode":400}`.
 */
export interface ConnectionTestResult {
  /** The host answered with something other than a server error. */
  success: boolean;
  statusCode?: number;
  responseTime?: number;
  /** One or two sentences for a person; never JSON. */
  message: string;
  /** Set when the test failed: the same sentence, for callers that read `error`. */
  error?: string;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** The host answered with `statusCode` after `responseTime` ms. */
export function answeredResult(baseUrl: string, statusCode: number, responseTime: number): ConnectionTestResult {
  const host = hostOf(baseUrl);
  const took = `${responseTime} ms`;
  if (statusCode >= 500) {
    const message = `${host} answered with a server error (HTTP ${statusCode}) after ${took}. The API may be down; try again later.`;
    return { success: false, statusCode, responseTime, message, error: message };
  }
  if (statusCode < 400) {
    return { success: true, statusCode, responseTime, message: `${host} answered in ${took} (HTTP ${statusCode}).` };
  }
  const why =
    statusCode === 401 || statusCode === 403
      ? 'Its main address asks for a key; run one of its tools to check the key.'
      : 'That is normal for an API that only answers on its own paths.';
  return {
    success: true,
    statusCode,
    responseTime,
    message: `${host} is reachable: it answered in ${took} with HTTP ${statusCode} on its main address. ${why}`,
  };
}

/** No answer: refused, timed out, or the name did not resolve. `detail` never names the errno. */
export function unreachableResult(baseUrl: string, detail: string): ConnectionTestResult {
  const message = `Could not reach ${hostOf(baseUrl)}: ${detail}`;
  return { success: false, message, error: message };
}

/** The address is one the server will not call (private, loopback, malformed). */
export function refusedResult(reason: string): ConnectionTestResult {
  const message = `This address can't be tested: ${reason}`;
  return { success: false, message, error: message };
}
