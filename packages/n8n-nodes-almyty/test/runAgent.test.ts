import { describe, expect, it, vi } from 'vitest';
import type { IHttpRequestOptions } from 'n8n-workflow';

import {
	RunFailedError,
	agentOptions,
	appBaseUrl,
	listAgents,
	mapRun,
	outputText,
	runAgent,
	startRequest,
	type Request,
} from '../nodes/Almyty/runAgent';

const BASE = 'https://api.example.test/';
const AUTONOMOUS = { id: 'a-1', name: 'Researcher', mode: 'autonomous', status: 'active' };
const WORKFLOW = { id: 'w-1', name: 'Summariser', mode: 'workflow', status: 'active' };

/**
 * A fake almyty API. `runs` is what successive GETs of the run answer;
 * the last one repeats. Every request is recorded.
 */
function fakeApi(agent: Record<string, unknown>, started: Record<string, unknown>, runs: Record<string, unknown>[] = []) {
	const calls: IHttpRequestOptions[] = [];
	let poll = 0;
	const request: Request = vi.fn(async (options: IHttpRequestOptions) => {
		calls.push(options);
		const url = String(options.url);
		if (options.method === 'GET' && url.endsWith(`/agents/${agent.id}`)) return { success: true, data: agent };
		if (options.method === 'POST') return { success: true, data: started };
		if (options.method === 'GET' && url.includes('/runs/')) {
			const run = runs[Math.min(poll, runs.length - 1)];
			poll++;
			return { success: true, data: run };
		}
		throw new Error(`unexpected request ${options.method} ${url}`);
	});
	return { request, calls };
}

/** A clock that moves only when the code sleeps. */
function fakeClock() {
	let t = 1_000_000;
	return {
		now: () => t,
		sleep: vi.fn(async (ms: number) => {
			t += ms;
		}),
	};
}

describe('startRequest', () => {
	it('starts an autonomous agent with the text as its task', () => {
		expect(startRequest(BASE, AUTONOMOUS, 'Find three hotels')).toEqual({
			method: 'POST',
			url: 'https://api.example.test/agents/a-1/runs',
			body: { input: 'Find three hotels' },
			json: true,
		});
	});

	it('invokes a workflow agent with the text as input.message', () => {
		expect(startRequest(BASE, WORKFLOW, 'Summarise this')).toEqual({
			method: 'POST',
			url: 'https://api.example.test/agents/w-1/invoke',
			body: { input: { message: 'Summarise this' } },
			json: true,
		});
	});

	it('encodes the agent id into the path', () => {
		expect(startRequest(BASE, { ...WORKFLOW, id: 'a/b' }, 'x').url).toBe(
			'https://api.example.test/agents/a%2Fb/invoke',
		);
	});
});

describe('listAgents and agentOptions', () => {
	it('reads every page and shows agents by name, saying which are not active', async () => {
		const pages: Record<number, unknown> = {
			1: { success: true, data: [{ id: '2', name: 'Zed', mode: 'workflow', status: 'active' }], pagination: { totalPages: 2 } },
			2: { success: true, data: [{ id: '1', name: 'Ada', mode: 'autonomous', status: 'draft' }], pagination: { totalPages: 2 } },
		};
		const request: Request = vi.fn(async (o: IHttpRequestOptions) => pages[Number(o.qs?.page)]);
		const agents = await listAgents(request, BASE);
		expect(request).toHaveBeenCalledTimes(2);
		expect((request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
			method: 'GET',
			url: 'https://api.example.test/agents',
			qs: { page: 1, limit: 100 },
		});
		expect(agentOptions(agents)).toEqual([
			{ name: 'Ada', value: '1', description: 'Autonomous agent, not active (draft)' },
			{ name: 'Zed', value: '2', description: 'Workflow agent' },
		]);
	});
});

describe('appBaseUrl', () => {
	it('turns the api host into the app host', () => {
		expect(appBaseUrl('https://api.almyty.com')).toBe('https://app.almyty.com');
		expect(appBaseUrl('https://api.staging.almyty.com/')).toBe('https://app.staging.almyty.com');
	});
	it('keeps a host that is not api.*, and prefers an explicit app URL', () => {
		expect(appBaseUrl('http://localhost:4000')).toBe('http://localhost:4000');
		expect(appBaseUrl('https://api.almyty.com', 'https://agents.example.com/')).toBe('https://agents.example.com');
	});
});

describe('outputText', () => {
	it('reads the answer from a string or a text-bearing object', () => {
		expect(outputText('hello')).toBe('hello');
		expect(outputText({ text: 'from text' })).toBe('from text');
		expect(outputText({ content: 'from content' })).toBe('from content');
		expect(outputText({ message: 'from message' })).toBe('from message');
		expect(outputText({ a: 1 })).toBe('{"a":1}');
		expect(outputText(null)).toBeNull();
	});
});

describe('runAgent', () => {
	it('with wait off returns only the run id and status, and does not poll', async () => {
		const api = fakeApi(AUTONOMOUS, { id: 'run-1', status: 'pending', totalCost: 0, output: null });
		const clock = fakeClock();
		const result = await runAgent(api.request, {
			baseUrl: BASE,
			agentId: 'a-1',
			input: 'hi',
			waitForResult: false,
			...clock,
		});
		expect(result).toEqual({ runId: 'run-1', status: 'pending' });
		expect(api.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
		expect(clock.sleep).not.toHaveBeenCalled();
	});

	it('completed: polls until done and returns output, cost and duration', async () => {
		const api = fakeApi(AUTONOMOUS, { id: 'run-1', status: 'running' }, [
			{ id: 'run-1', status: 'running' },
			{ id: 'run-1', status: 'completed', output: { text: 'Done: 42' }, totalCost: 0.0031, executionTime: 5400 },
		]);
		const result = await runAgent(api.request, {
			baseUrl: BASE,
			agentId: 'a-1',
			input: 'hi',
			waitForResult: true,
			...fakeClock(),
		});
		expect(result).toEqual({ runId: 'run-1', status: 'completed', output: 'Done: 42', cost: 0.0031, durationMs: 5400 });
		expect(api.calls.at(-1)).toMatchObject({ method: 'GET', url: 'https://api.example.test/agents/a-1/runs/run-1' });
	});

	it('completed without a reported cost or duration gives null, not 0', async () => {
		const api = fakeApi(AUTONOMOUS, { id: 'run-1', status: 'running' }, [
			{ id: 'run-1', status: 'completed', output: 'ok', totalCost: 0, executionTime: undefined },
		]);
		const result = await runAgent(api.request, { baseUrl: BASE, agentId: 'a-1', input: 'hi', waitForResult: true, ...fakeClock() });
		expect(result.cost).toBeNull();
		expect(result.durationMs).toBeNull();
		expect(result.output).toBe('ok');
	});

	it('waiting for approval: status, run id and a link to the run, not an error', async () => {
		const api = fakeApi(AUTONOMOUS, { id: 'run-9', status: 'running' }, [{ id: 'run-9', status: 'waiting_approval' }]);
		const result = await runAgent(api.request, {
			baseUrl: 'https://api.almyty.com',
			agentId: 'a-1',
			input: 'send the invoice',
			waitForResult: true,
			...fakeClock(),
		});
		expect(result).toEqual({
			runId: 'run-9',
			status: 'waiting_approval',
			waitingFor: 'approval',
			runUrl: 'https://app.almyty.com/agents/a-1/runs/run-9',
		});
	});

	it('timeout: stops waiting at the max wait and returns the run as still running', async () => {
		// A run sleeping while its hosted machine starts is still running.
		const api = fakeApi(AUTONOMOUS, { id: 'run-2', status: 'running' }, [{ id: 'run-2', status: 'sleeping' }]);
		const clock = fakeClock();
		const result = await runAgent(api.request, {
			baseUrl: BASE,
			agentId: 'a-1',
			input: 'hi',
			waitForResult: true,
			maxWaitMs: 10_000,
			pollIntervalMs: 2_000,
			...clock,
		});
		expect(result).toEqual({
			runId: 'run-2',
			status: 'running',
			runStatus: 'sleeping',
			runUrl: 'https://app.example.test/agents/a-1/runs/run-2',
		});
		const waited = clock.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
		expect(waited).toBe(10_000);
		expect(clock.sleep).toHaveBeenCalledTimes(5);
	});

	it('failed: throws with the run’s own error message', async () => {
		const api = fakeApi(AUTONOMOUS, { id: 'run-3', status: 'running' }, [
			{ id: 'run-3', status: 'failed', error: 'Model refused the key' },
		]);
		const promise = runAgent(api.request, { baseUrl: BASE, agentId: 'a-1', input: 'hi', waitForResult: true, ...fakeClock() });
		await expect(promise).rejects.toBeInstanceOf(RunFailedError);
		await expect(promise).rejects.toMatchObject({
			message: 'Model refused the key',
			result: { runId: 'run-3', status: 'failed', error: 'Model refused the key' },
		});
	});

	it('a workflow agent answers in one call, with no polling', async () => {
		const api = fakeApi(WORKFLOW, {
			id: 'exec-1',
			status: 'completed',
			output: { content: 'Summary here' },
			totalCost: 0.0002,
			executionTime: 800,
		});
		const clock = fakeClock();
		const result = await runAgent(api.request, { baseUrl: BASE, agentId: 'w-1', input: 'x', waitForResult: true, ...clock });
		expect(result).toEqual({ runId: 'exec-1', status: 'completed', output: 'Summary here', cost: 0.0002, durationMs: 800 });
		expect(api.calls).toHaveLength(2);
		expect(clock.sleep).not.toHaveBeenCalled();
	});
});

describe('mapRun', () => {
	it('treats cancelled and timeout as failures', () => {
		expect(() => mapRun({ id: 'r', status: 'cancelled' }, 'a', 'https://app.x')).toThrow('The run ended with status "cancelled".');
		expect(() => mapRun({ id: 'r', status: 'timeout', error: 'Ran out of time' }, 'a', 'https://app.x')).toThrow('Ran out of time');
	});
	it('waiting for input links to the run too', () => {
		expect(mapRun({ id: 'r', status: 'waiting_input' }, 'a', 'https://app.x')).toEqual({
			runId: 'r',
			status: 'waiting_input',
			waitingFor: 'input',
			runUrl: 'https://app.x/agents/a/runs/r',
		});
	});
});
