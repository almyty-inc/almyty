/**
 * One sentence a user can act on, for every way a chat session fails.
 *
 * A REPL that answers "API error 400: {"success":false,...}" has told the
 * user nothing. Every failure a session can reach has a cause and a next
 * step, and both are known here rather than left for the reader to infer
 * from a status code.
 *
 * Kept free of ink and of the network client so it can be tested as the
 * pure mapping it is.
 */

/** What the session knows about itself when something fails. */
export interface ErrorContext {
  /** `<org>/<agent-slug>`, as the user typed it. */
  agentRef?: string;
  /** API base URL, for "cannot reach" messages. */
  apiUrl?: string;
  /** Dashboard URL, for "fix it here" messages. */
  appUrl?: string;
  /** What the session was doing: shapes the timeout wording. */
  what?: 'run' | 'info' | 'history' | 'stream' | 'cancel';
}

export const DEFAULT_APP_URL = 'https://app.almyty.com';

interface Failure {
  status?: number;
  code?: string;
  serverMessage?: string;
  message: string;
  network: boolean;
  aborted: boolean;
  pollTimeout: boolean;
}

/** Pull everything useful off a thrown value, whatever shape it has. */
export function inspectError(err: unknown): Failure {
  const e = (err ?? {}) as Record<string, any>;
  const message = typeof e.message === 'string' && e.message ? e.message : String(err ?? 'Unknown error');

  let status: number | undefined = typeof e.status === 'number' ? e.status : undefined;
  if (status === undefined) {
    // Errors that crossed a package boundary as plain strings.
    const m = message.match(/^(?:API error|SSE) (\d{3})/);
    if (m) status = Number(m[1]);
  }

  let code: string | undefined;
  let serverMessage: string | undefined;
  const body = typeof e.body === 'string' ? e.body : message;
  const jsonStart = body.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(body.slice(jsonStart));
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.error === 'string') code = parsed.error;
        if (typeof parsed.code === 'string') code = parsed.code;
        if (typeof parsed.message === 'string') serverMessage = parsed.message;
      }
    } catch {
      /* not JSON; the raw message is all there is */
    }
  }
  if (!code && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code)) code = e.code;

  const errno = typeof e.code === 'string' ? e.code : (e.cause as any)?.code;
  const network =
    e.networkError === true ||
    ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(errno) ||
    /fetch failed|network|socket hang up|ECONNRESET/i.test(message);

  return {
    status,
    code,
    serverMessage,
    message,
    network,
    aborted: e.name === 'AbortError' || e.code === 'ABORT_ERR',
    pollTimeout: e.pollTimeout === true || /did not finish within/.test(message),
  };
}

/** The model name out of a MODEL_NOT_FOUND message, when it names one. */
export function extractModelName(message: string): string | null {
  const quoted = message.match(/"([^"]{2,80})"\s+is not available/) || message.match(/model\s+"([^"]{2,80})"/i);
  return quoted ? quoted[1] : null;
}

/**
 * Turn a thrown value into one sentence, plus the command or URL that
 * fixes it.
 */
export function explainError(err: unknown, ctx: ErrorContext = {}): string {
  const f = inspectError(err);
  const ref = ctx.agentRef ?? 'this agent';
  const app = ctx.appUrl ?? DEFAULT_APP_URL;

  if (f.aborted) return 'Cancelled.';

  if (f.network) {
    const host = ctx.apiUrl ?? 'the almyty API';
    return `Cannot reach ${host}. Check your connection, or ALMYTY_URL if you are pointing at your own deployment.`;
  }

  // Codes first: the server names the cause, so use its word for it.
  switch (f.code) {
    case 'AGENT_NOT_ACTIVE':
      return `${ref} is not active, so it will not answer. Open ${app}/agents, activate it, and try again.`;
    case 'AGENT_AUTH_REQUIRED':
    case 'AGENT_AUTH_INVALID':
      return 'Not authenticated. Run: npx @almyty/auth login';
    case 'AGENT_AUTH_EXPIRED':
      return 'Your credentials have expired. Run: npx @almyty/auth login';
    case 'AGENT_AUTH_FORBIDDEN':
      return `Your account has no access to the organization that owns ${ref}. Check the org in the reference, or log in as an account that does: npx @almyty/auth login`;
    case 'MODEL_NOT_FOUND': {
      const model = extractModelName(f.serverMessage ?? f.message);
      return `${ref} is configured to use ${model ? `the model ${model}, which` : 'a model that'} its provider no longer serves. Pick a model that is available at ${app}/agents — scheduled runs stay paused until you do.`;
    }
    case 'BUDGET_EXCEEDED':
    case 'SPEND_LIMIT_EXCEEDED':
      return `This organization has reached its spend cap, so no new model calls will run. Raise it or wait for the period to reset at ${app}/settings.`;
  }

  const body = f.serverMessage ?? f.message;

  if (/MODEL_NOT_FOUND|is not available/i.test(body)) {
    const model = extractModelName(body);
    return `${ref} is configured to use ${model ? `the model ${model}, which` : 'a model that'} its provider no longer serves. Pick a model that is available at ${app}/agents — scheduled runs stay paused until you do.`;
  }
  if (/no LLM provider configured|modelConfig\.providerId/i.test(body)) {
    return `${ref} has no model configured. Open it at ${app}/agents and choose a model or a routing policy.`;
  }
  if (/not autonomous/i.test(body)) {
    return `${ref} is a workflow agent, so it has no multi-turn run to continue. It answers one message at a time and that is what this session will do.`;
  }
  if (/budget|spend (cap|limit)|quota/i.test(body)) {
    return `This organization has reached its spend cap, so no new model calls will run. Raise it or wait for the period to reset at ${app}/settings.`;
  }

  if (f.pollTimeout) {
    return 'The run is taking longer than this session will wait. It is still going server-side — reconnect with --resume once it finishes, or stop it from the dashboard.';
  }

  switch (f.status) {
    case 400:
      return `${ref} rejected the request: ${body}`;
    case 401:
      return 'Not authenticated, or the stored token has expired. Run: npx @almyty/auth login';
    case 403:
      return `Your account has no access to ${ref}. Check the organization in the reference, or log in as an account that does: npx @almyty/auth login`;
    case 404:
      return `No agent at ${ref}. See what you can reach with: npx @almyty/agents list`;
    case 409:
      return `${ref} is busy with a conflicting request: ${body}`;
    case 429:
      return 'Rate limited. Wait a few seconds and send it again.';
    case 500:
    case 502:
    case 503:
    case 504:
      return `almyty's API answered ${f.status}. This is server-side — retry in a moment, and check status if it keeps happening.`;
  }

  return body;
}

/**
 * Why `<org>/<agent>` could not be opened at startup.
 *
 * Startup is the one place a bad reference and a bad login look the
 * same, and where "Agent not found" was printed for both.
 */
export function explainStartupFailure(err: unknown, ctx: ErrorContext = {}): string {
  return explainError(err, { ...ctx, what: 'info' });
}
