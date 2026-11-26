/**
 * Running an almyty agent over its REST API, apart from n8n's plumbing so
 * the request building and the result mapping can be tested on their own.
 *
 * The calls are the ones the almyty CLI makes (packages/client):
 *   GET  /agents                      the organization's agents
 *   GET  /agents/:id                  one agent, for its mode
 *   POST /agents/:id/runs             start an autonomous agent's run
 *   GET  /agents/:id/runs/:runId      the run as it stands
 *   POST /agents/:id/invoke           run a workflow agent to the end
 * Every answer is wrapped as { success, data }.
 */

import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

/** An API answer: JSON whose shape the code checks as it reads it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiBody = any;

export type Request = (options: IHttpRequestOptions) => Promise<ApiBody>;

export interface AgentSummary {
	id: string;
	name: string;
	mode?: string;
	status?: string;
	description?: string;
}

/** A run or a workflow execution, as the API answers with one. */
export interface RunRecord {
	id?: string;
	status?: string;
	output?: unknown;
	error?: string | null;
	totalCost?: number | null;
	executionTime?: number | null;
}

/** What the node hands to the next step. */
export interface RunResult extends IDataObject {
	runId: string | null;
	status: string;
}

/** A run that ended badly: the node reports it as an error. */
export class RunFailedError extends Error {
	constructor(
		message: string,
		readonly result: RunResult,
	) {
		super(message);
		this.name = 'RunFailedError';
	}
}

/** Statuses a run ends in successfully. */
const COMPLETED = new Set(['completed']);
/** Statuses a run ends in without an answer. */
const FAILED = new Set(['failed', 'cancelled', 'timeout']);
/** Statuses where the run waits for a person before it goes on. */
const WAITING = new Set(['waiting_approval', 'waiting_input']);

export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;
/** The longest Max Wait the node accepts: a day, as long as an approval stays open by default. */
export const MAX_WAIT_LIMIT_MS = 24 * 60 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;
/** How often a run that waits for a person is checked: people take minutes, not seconds. */
export const PERSON_POLL_INTERVAL_MS = 10_000;

/**
 * What the node does when the run stops for a person (an approval or more
 * input): hand back the status at once, or keep checking until the run ends
 * or Max Wait runs out.
 */
export type IfRunNeedsPerson = 'returnStatus' | 'keepWaiting';
export const DEFAULT_IF_RUN_NEEDS_PERSON: IfRunNeedsPerson = 'returnStatus';

export function trimBaseUrl(baseUrl: string): string {
	return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * Where a person opens a run in the almyty app. An explicit app URL wins;
 * otherwise the API's own host with `api.` turned into `app.`
 * (api.almyty.com -> app.almyty.com), and the API's origin when its host
 * does not start with `api.`.
 */
export function appBaseUrl(apiBaseUrl: string, appUrl?: string): string {
	if (appUrl && appUrl.trim()) return trimBaseUrl(appUrl);
	try {
		const url = new URL(trimBaseUrl(apiBaseUrl));
		if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`;
		return url.origin;
	} catch {
		return trimBaseUrl(apiBaseUrl);
	}
}

export function runUrl(appBase: string, agentId: string, runId: string): string {
	return `${appBase}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`;
}

function unwrap(body: ApiBody): ApiBody {
	return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

export function listAgentsRequest(baseUrl: string, page: number): IHttpRequestOptions {
	return {
		method: 'GET',
		url: `${trimBaseUrl(baseUrl)}/agents`,
		qs: { page, limit: 100, sortBy: 'name', sortOrder: 'ASC' },
		json: true,
	};
}

export function getAgentRequest(baseUrl: string, agentId: string): IHttpRequestOptions {
	return {
		method: 'GET',
		url: `${trimBaseUrl(baseUrl)}/agents/${encodeURIComponent(agentId)}`,
		json: true,
	};
}

/**
 * The request that starts the agent. An autonomous agent takes the text as
 * its task (as `almyty agents run` sends it); a workflow agent takes
 * `{ message }`, which its steps read as `{{input.message}}`.
 *
 * A workflow agent's /invoke holds the connection until the execution ends,
 * so `timeoutMs` (the node's Max Wait) bounds that one call. An autonomous
 * agent's start answers at once and needs no limit of its own.
 */
export function startRequest(
	baseUrl: string,
	agent: AgentSummary,
	input: string,
	timeoutMs?: number,
): IHttpRequestOptions {
	const base = `${trimBaseUrl(baseUrl)}/agents/${encodeURIComponent(agent.id)}`;
	if (agent.mode === 'autonomous') {
		return { method: 'POST', url: `${base}/runs`, body: { input }, json: true };
	}
	return {
		method: 'POST',
		url: `${base}/invoke`,
		body: { input: { message: input } },
		json: true,
		...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
	};
}

export function getRunRequest(baseUrl: string, agentId: string, runId: string): IHttpRequestOptions {
	return {
		method: 'GET',
		url: `${trimBaseUrl(baseUrl)}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
		json: true,
	};
}

/** Every agent in the organization, page by page. */
export async function listAgents(request: Request, baseUrl: string): Promise<AgentSummary[]> {
	const agents: AgentSummary[] = [];
	for (let page = 1; page <= 50; page++) {
		const body = await request(listAgentsRequest(baseUrl, page));
		const rows: ApiBody[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
		for (const row of rows) {
			if (row?.id) {
				agents.push({
					id: String(row.id),
					name: String(row.name ?? row.id),
					mode: row.mode,
					status: row.status,
					description: row.description,
				});
			}
		}
		const totalPages = Number(body?.pagination?.totalPages ?? 1);
		if (rows.length === 0 || page >= totalPages) break;
	}
	return agents;
}

/** The agent list as the node's dropdown shows it. */
export function agentOptions(agents: AgentSummary[]): Array<{ name: string; value: string; description?: string }> {
	return [...agents]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((agent) => {
			const bits: string[] = [];
			if (agent.mode) bits.push(agent.mode === 'autonomous' ? 'Autonomous agent' : 'Workflow agent');
			if (agent.status && agent.status !== 'active') bits.push(`not active (${agent.status})`);
			return {
				name: agent.name,
				value: agent.id,
				...(bits.length ? { description: bits.join(', ') } : {}),
			};
		});
}

/**
 * The answer as text. A run's output is a string, or an object carrying it
 * as `text`, `content` or `message` (the same reading almyty's chat API
 * uses); anything else is passed on as JSON.
 */
export function outputText(output: unknown): string | null {
	if (output == null) return null;
	if (typeof output === 'string') return output;
	if (typeof output === 'object') {
		const fields = output as Record<string, unknown>;
		for (const key of ['text', 'content', 'message', 'output', 'result']) {
			if (typeof fields[key] === 'string') return fields[key] as string;
		}
	}
	return JSON.stringify(output);
}

/** A number the API reported, or null. The API stores 0 when it recorded nothing. */
function reported(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Whether the node stops checking a run in this state. A run waiting for a
 * person counts as settled unless the node was told to keep waiting.
 */
export function isSettled(status: string | undefined, keepWaitingForPerson = false): boolean {
	const s = String(status ?? '');
	return COMPLETED.has(s) || FAILED.has(s) || (!keepWaitingForPerson && WAITING.has(s));
}

export function isWaitingForPerson(status: string | undefined): boolean {
	return WAITING.has(String(status ?? ''));
}

/**
 * What the next step gets for a run in a given state.
 *   completed  output, cost (USD) and duration (ms), null when not reported
 *   waiting    status, run id and a link where a person approves or answers
 *   failed     RunFailedError carrying the run's own error message
 *   otherwise  (still going when the wait ran out) status "running", run id and link
 */
export function mapRun(run: RunRecord, agentId: string, appBase: string): RunResult {
	const runId = run.id ? String(run.id) : null;
	const status = String(run.status ?? 'unknown');
	const link = runId ? runUrl(appBase, agentId, runId) : null;

	if (COMPLETED.has(status)) {
		return {
			runId,
			status,
			output: outputText(run.output),
			cost: reported(run.totalCost),
			durationMs: reported(run.executionTime),
		};
	}
	if (FAILED.has(status)) {
		const reason = run.error ? String(run.error) : `The run ended with status "${status}".`;
		throw new RunFailedError(reason, { runId, status, error: reason, runUrl: link });
	}
	if (WAITING.has(status)) {
		return {
			runId,
			status,
			waitingFor: status === 'waiting_approval' ? 'approval' : 'input',
			runUrl: link,
		};
	}
	// Still going when the wait ran out. A run may be pending, running or
	// sleeping a moment (a hosted machine starting); to the workflow they
	// are all "running", and runStatus keeps the run's own word for it.
	return { runId, status: 'running', runStatus: status, runUrl: link };
}

export interface RunAgentOptions {
	baseUrl: string;
	appUrl?: string;
	agentId: string;
	input: string;
	waitForResult: boolean;
	/** What to do when the run stops for a person. Default: return the status. */
	ifRunNeedsPerson?: IfRunNeedsPerson;
	maxWaitMs?: number;
	pollIntervalMs?: number;
	/** How often to check a run that waits for a person. */
	personPollIntervalMs?: number;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Max Wait as the node uses it: the default when unset, never more than a day. */
export function effectiveMaxWaitMs(maxWaitMs: number | undefined): number {
	const ms = typeof maxWaitMs === 'number' && Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : DEFAULT_MAX_WAIT_MS;
	return Math.min(ms, MAX_WAIT_LIMIT_MS);
}

/**
 * Start the agent and, when asked to, wait for it to settle. Whatever state
 * the run is in when the node stops looking, it goes through mapRun, so a
 * start that already answers failed or cancelled raises even with waiting
 * off, and one that already answers completed carries its output.
 *
 * With ifRunNeedsPerson "keepWaiting", a run waiting for an approval or for
 * input is checked on (every personPollIntervalMs) until it completes or
 * fails. If Max Wait runs out first, the run's waiting status comes back as
 * it is, with the link to it: the node never reports an unfinished run as
 * finished.
 */
export async function runAgent(request: Request, options: RunAgentOptions): Promise<RunResult> {
	const now = options.now ?? Date.now;
	const appBase = appBaseUrl(options.baseUrl, options.appUrl);
	const agent: AgentSummary = unwrap(await request(getAgentRequest(options.baseUrl, options.agentId)));
	if (!agent?.id) throw new Error(`No agent with id ${options.agentId} in this organization.`);

	const maxWaitMs = effectiveMaxWaitMs(options.maxWaitMs);
	let run: RunRecord = unwrap(await request(startRequest(options.baseUrl, agent, options.input, maxWaitMs))) ?? {};

	if (!options.waitForResult) return mapRun(run, agent.id, appBase);

	// A workflow agent answers with the finished execution; an autonomous
	// one with the run it has just started, which is polled until it settles.
	const keepWaiting = (options.ifRunNeedsPerson ?? DEFAULT_IF_RUN_NEEDS_PERSON) === 'keepWaiting';
	const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const personInterval = options.personPollIntervalMs ?? PERSON_POLL_INTERVAL_MS;
	const deadline = now() + maxWaitMs;
	while (agent.mode === 'autonomous' && run?.id && !isSettled(run.status, keepWaiting) && now() < deadline) {
		const pause = isWaitingForPerson(run.status) ? personInterval : interval;
		await options.sleep(Math.min(pause, Math.max(0, deadline - now())));
		run = unwrap(await request(getRunRequest(options.baseUrl, agent.id, String(run.id)))) ?? {};
	}
	return mapRun(run, agent.id, appBase);
}