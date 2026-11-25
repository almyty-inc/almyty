import { describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions } from 'n8n-workflow';

// The node waits between polls with n8n's own sleep; these tests do not.
vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => undefined),
}));

import { Almyty } from '../nodes/Almyty/Almyty.node';
import { AlmytyApi } from '../credentials/AlmytyApi.credentials';

const CREDENTIALS = { baseUrl: 'https://api.almyty.com/', apiKey: 'almyty_test', appUrl: '' };

type Handler = (options: IHttpRequestOptions) => unknown;

/** Just enough of n8n's execute context for the node. */
function executeContext(params: Record<string, unknown>, handler: Handler, continueOnFail = false) {
	const http = vi.fn(async (_credential: string, options: IHttpRequestOptions) => handler(options));
	const ctx = {
		getInputData: () => [{ json: {} }],
		getCredentials: vi.fn(async () => CREDENTIALS),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
		getNode: () => ({ id: 'n1', name: 'almyty', type: 'n8n-nodes-almyty.almyty', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: { httpRequestWithAuthentication: http },
	};
	return { ctx: ctx as unknown as IExecuteFunctions, http };
}

function autonomousApi(finalRun: Record<string, unknown>): Handler {
	return (o) => {
		const url = String(o.url);
		if (o.method === 'GET' && url.endsWith('/agents/a-1')) {
			return { success: true, data: { id: 'a-1', name: 'Researcher', mode: 'autonomous', status: 'active' } };
		}
		if (o.method === 'POST') return { success: true, data: { id: 'run-1', status: 'running' } };
		return { success: true, data: { id: 'run-1', ...finalRun } };
	};
}

const PARAMS = { agentId: 'a-1', input: 'What is 6 x 7?', waitForResult: true, maxWaitSeconds: 300 };

describe('Almyty node execute', () => {
	it('runs the agent with the saved credential and returns the answer', async () => {
		const { ctx, http } = executeContext(
			PARAMS,
			autonomousApi({ status: 'completed', output: '42', totalCost: 0.001, executionTime: 1200 }),
		);
		const [items] = await new Almyty().execute.call(ctx);
		expect(items).toEqual([
			{
				json: { runId: 'run-1', status: 'completed', output: '42', cost: 0.001, durationMs: 1200 },
				pairedItem: { item: 0 },
			},
		]);
		expect(http.mock.calls.every(([credential]) => credential === 'almytyApi')).toBe(true);
		expect(http.mock.calls[1][1]).toMatchObject({
			method: 'POST',
			url: 'https://api.almyty.com/agents/a-1/runs',
			body: { input: 'What is 6 x 7?' },
		});
	});

	it('a failed run is a node error carrying the run’s message', async () => {
		const { ctx } = executeContext(PARAMS, autonomousApi({ status: 'failed', error: 'No model is connected' }));
		await expect(new Almyty().execute.call(ctx)).rejects.toThrow('The agent run failed: No model is connected');
	});

	it('a failed run with Continue On Fail becomes an output item instead', async () => {
		const { ctx } = executeContext(PARAMS, autonomousApi({ status: 'failed', error: 'No model is connected' }), true);
		const [items] = await new Almyty().execute.call(ctx);
		expect(items[0].json).toEqual({
			runId: 'run-1',
			status: 'failed',
			error: 'No model is connected',
			runUrl: 'https://app.almyty.com/agents/a-1/runs/run-1',
		});
	});

	it('wait off returns the run id and status only', async () => {
		const { ctx, http } = executeContext({ ...PARAMS, waitForResult: false }, autonomousApi({ status: 'completed' }));
		const [items] = await new Almyty().execute.call(ctx);
		expect(items[0].json).toEqual({ runId: 'run-1', status: 'running' });
		expect(http).toHaveBeenCalledTimes(2);
	});
});

describe('Almyty node agent list', () => {
	it('lists the organization’s agents from the credential’s base URL', async () => {
		const http = vi.fn(async () => ({
			success: true,
			data: [{ id: 'a-1', name: 'Researcher', mode: 'autonomous', status: 'active' }],
			pagination: { totalPages: 1 },
		}));
		const ctx = {
			getCredentials: async () => CREDENTIALS,
			helpers: { httpRequestWithAuthentication: http },
		} as unknown as ILoadOptionsFunctions;
		const options = await new Almyty().methods.loadOptions.getAgents.call(ctx);
		expect(options).toEqual([{ name: 'Researcher', value: 'a-1', description: 'Autonomous agent' }]);
		expect(http).toHaveBeenCalledWith('almytyApi', expect.objectContaining({ url: 'https://api.almyty.com/agents' }));
	});
});

describe('almyty API credential', () => {
	const credential = new AlmytyApi();
	it('sends the key as a bearer token and tests it against the agent list', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
		expect(credential.test.request.url).toBe('/agents');
		expect(credential.properties.find((p) => p.name === 'baseUrl')?.default).toBe('https://api.almyty.com');
	});
});
