/**
 * What this server knows about the upstream gateway, and when it last
 * asked.
 *
 * Discovery used to happen once, before the transport was connected: a
 * backend that was down or a token that had gone stale killed the process
 * during the MCP handshake, so the host editor saw the server die rather
 * than a server that could explain itself. And a gateway that gained or
 * lost a tool stayed invisible until someone restarted the editor.
 *
 * So discovery lives here instead: it never throws, it remembers why it
 * last failed, and it re-asks when what it holds has gone stale.
 */

export interface ToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface SkillSummary {
  name: string;
  content: string;
  toolCount: number;
}

/** The slice of the proxy the catalog needs, so a test can stand in for it. */
export interface DiscoverySource {
  fetchTools(): Promise<ToolSummary[]>;
  fetchSkills(): Promise<SkillSummary[]>;
}

export interface CatalogOptions {
  /** How long a discovery result is trusted before it is re-asked. */
  ttlMs?: number;
  now?: () => number;
  warn?: (msg: string) => void;
}

const DEFAULT_TTL_MS = 60_000;

export class ToolCatalog {
  private toolList: ToolSummary[] = [];
  private skillList: SkillSummary[] = [];
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;
  private failure: string | null = null;

  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;

  constructor(private readonly source: DiscoverySource, options: CatalogOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    // stdout carries the MCP protocol and nothing else, so every log line
    // this process writes goes to stderr.
    this.warn = options.warn ?? ((m) => process.stderr.write(`[almyty mcp-server] ${m}\n`));
  }

  get tools(): ToolSummary[] { return this.toolList; }
  get skills(): SkillSummary[] { return this.skillList; }
  /** Why the last discovery failed, or null when it worked. */
  get lastError(): string | null { return this.failure; }
  /** True once discovery has succeeded at least once. */
  get discovered(): boolean { return this.fetchedAt > 0; }

  isStale(): boolean {
    return this.fetchedAt === 0 || this.now() - this.fetchedAt >= this.ttlMs;
  }

  /**
   * Ask the backend. Never throws: a failure is recorded and reported on the
   * tool call that needed it, where the model can see it and say so, rather
   * than as an exception nobody is waiting for.
   *
   * Concurrent callers share one request; a failure keeps whatever was
   * already known, because a stale tool list is more use than none.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const [tools, skills] = await Promise.all([this.source.fetchTools(), this.source.fetchSkills()]);
        this.toolList = tools;
        this.skillList = skills;
        this.fetchedAt = this.now();
        this.failure = null;
      } catch (err: any) {
        this.failure = err?.message ? String(err.message) : String(err);
        this.warn(`discovery failed: ${this.failure}`);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Re-ask only when what we hold has aged out. */
  async ensureFresh(): Promise<void> {
    if (this.isStale()) await this.refresh();
  }

  /** Substring match over names and descriptions, the cheapest thing that works. */
  search(query: string): ToolSummary[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.toolList;
    return this.toolList.filter((t) =>
      t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
  }
}

/**
 * Sanitize a skill name into a valid MCP prompt identifier: anything outside
 * [a-zA-Z0-9_-] (a slash from `billing/invoices`, say) becomes an underscore, so
 * a real-world skill name cannot break the registration.
 */
export function sanitizePromptName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '') || 'skill';
}

/**
 * Prompt names must be unique, and two different skill names can sanitize to
 * the same identifier (`billing/invoices` and `billing-invoices` both become
 * `billing_invoices`). The second one gets a suffix rather than overwriting the
 * first.
 */
export function uniquePromptNames(skillNames: string[]): string[] {
  const used = new Set<string>();
  return skillNames.map((name) => {
    let candidate = `skill-${sanitizePromptName(name)}`;
    if (used.has(candidate)) {
      let suffix = 2;
      while (used.has(`${candidate}-${suffix}`)) suffix++;
      candidate = `${candidate}-${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * What to tell the model when a call to almyty failed.
 *
 * A raw `401 {"statusCode":401,...}` body in a tool result is the worst of
 * both worlds: the model cannot act on it and the person reading the
 * transcript does not learn that their login expired. Every one of these
 * says what to do next.
 */
export function upstreamErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b401\b|unauthor/i.test(message)) {
    return `almyty rejected the credential (${message}). The token is missing or has expired: run \`npx @almyty/auth login\`, or set ALMYTY_TOKEN, then restart this MCP server.`;
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return `almyty refused the request (${message}). The token is valid but lacks permission for this gateway or organization.`;
  }
  if (/\b404\b/.test(message)) {
    return `almyty has no such route or gateway (${message}). Check ALMYTY_GATEWAY_ID: it is "orgSlug/gatewaySlug".`;
  }
  if (/timed out/i.test(message)) {
    return `${message}. almyty did not answer in time; the call was abandoned rather than left hanging.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) {
    return `Could not reach almyty (${message}). Check ALMYTY_URL and the network.`;
  }
  return message;
}

/** The text `almyty_search` answers with. Separated out so it can be checked. */
export function searchResultText(query: string, matches: ToolSummary[], all: ToolSummary[], limit = 20): string {
  if (matches.length === 0) {
    const sample = all.slice(0, 10).map((t) => t.name).join(', ');
    const more = all.length > 10 ? ` ... and ${all.length - 10} more` : '';
    return all.length === 0
      ? `No tools are available. This gateway exposes none, or discovery has not succeeded — see the server's stderr.`
      : `No tools found matching "${query}". Available tools: ${sample}${more}`;
  }
  const lines = matches.slice(0, limit).map((t) => `- **${t.name}**: ${t.description ?? ''}`).join('\n');
  const truncated = matches.length > limit ? `\n(${matches.length - limit} more not shown; narrow the query)` : '';
  return `Found ${matches.length} tools:\n${lines}${truncated}\n\nLoad the relevant skill prompt for detailed usage instructions, then call almyty_execute.`;
}
