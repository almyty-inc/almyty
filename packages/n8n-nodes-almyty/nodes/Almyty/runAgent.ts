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
export const POLL_INTERVAL_MS = 2000;

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
 */
export function startRequest(baseUrl: string, agent: AgentSummary, input: string): IHttpRequestOptions {
	const base = `${trimBaseUrl(baseUrl)}/agents/${encodeURIComponent(agent.id)}`;
	if (agent.mode === 'autonomous') {
		return { method: 'POST', url: `${base}/runs`, body: { input }, json: true };
	}
	return { method: 'POST', url: `${base}/invoke`, body: { input: { message: input } }, json: true };
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

export function isSettled(status: string | undefined): boolean {
	const s = String(status ?? '');
	return COMPLETED.has(s) || FAILED.has(s) || WAITING.has(s);
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
	maxWaitMs?: number;
	pollIntervalMs?: number;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Start the agent and, when asked to, wait for it to settle. */
export async function runAgent(request: Request, options: RunAgentOptions): Promise<RunResult> {
	const now = options.now ?? Date.now;
	const appBase = appBaseUrl(options.baseUrl, options.appUrl);
	const agent: AgentSummary = unwrap(await request(getAgentRequest(options.baseUrl, options.agentId)));
	if (!agent?.id) throw new Error(`No agent with id ${options.agentId} in this organization.`);

	let run: RunRecord = unwrap(await request(startRequest(options.baseUrl, agent, options.input)));

	if (!options.waitForResult) {
		return { runId: run?.id ? String(run.id) : null, status: String(run?.status ?? 'unknown') };
	}

	// A workflow agent answers with the finished execution; an autonomous
	// one with the run it has just started, which is polled until it settles.
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const deadline = now() + maxWaitMs;
	while (agent.mode === 'autonomous' && run?.id && !isSettled(run.status) && now() < deadline) {
		await options.sleep(Math.min(interval, Math.max(0, deadline - now())));
		run = unwrap(await request(getRunRequest(options.baseUrl, agent.id, String(run.id))));
	}
	return mapRun(run, agent.id, appBase);
}
