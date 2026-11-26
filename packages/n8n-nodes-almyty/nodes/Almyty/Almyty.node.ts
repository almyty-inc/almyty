import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import {
	DEFAULT_IF_RUN_NEEDS_PERSON,
	DEFAULT_MAX_WAIT_MS,
	RunFailedError,
	agentOptions,
	listAgents,
	runAgent,
	type IfRunNeedsPerson,
	type Request,
} from './runAgent';

const CREDENTIAL = 'almytyApi';

export class Almyty implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'almyty',
		name: 'almyty',
		// The mark carries its own dark tile, so one file reads on both themes.
		icon: { light: 'file:../../icons/almyty.svg', dark: 'file:../../icons/almyty.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{"Run agent"}}',
		description: 'Run an almyty agent and pass its answer to the next step',
		defaults: {
			name: 'almyty',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Run Agent',
						value: 'runAgent',
						description: 'Give an agent a task and get its answer',
						action: 'Run an agent',
					},
				],
				default: 'runAgent',
			},
			{
				displayName: 'Agent Name or ID',
				name: 'agentId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getAgents',
				},
				default: '',
				required: true,
				description:
					'The agent to run. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { operation: ['runAgent'] } },
			},
			{
				displayName: 'Input',
				name: 'input',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				description: 'What you ask the agent to do',
				displayOptions: { show: { operation: ['runAgent'] } },
			},
			{
				displayName: 'Wait for Result',
				name: 'waitForResult',
				type: 'boolean',
				default: true,
				description:
					'Whether to wait for the agent to finish and return its answer. Off returns the run ID and status as soon as the run has started. Workflow agents always answer in one call; this applies to autonomous agents.',
				displayOptions: { show: { operation: ['runAgent'] } },
			},
			{
				displayName: 'If the Run Needs a Person',
				name: 'ifRunNeedsPerson',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Return the Status Now',
						value: 'returnStatus',
						description:
							'The step ends at once with the status waiting_approval or waiting_input, the run ID and a link to the run. The workflow goes on without the answer.',
					},
					{
						name: 'Keep Waiting',
						value: 'keepWaiting',
						description:
							'The step keeps checking the run while someone approves or answers in almyty, and returns the answer once the run completes. If Max Wait runs out first, you get the waiting status and the link.',
					},
				],
				default: 'returnStatus',
				description:
					'What the step does when an autonomous agent stops for an approval or for more input from a person',
				displayOptions: { show: { operation: ['runAgent'], waitForResult: [true] } },
			},
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWaitSeconds',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 86400 },
				default: 300,
				description:
					'How long this step waits for the answer, at most 86400 (24 hours). The n8n execution keeps running all that time, and an execution timeout set in n8n ends it sooner. For an autonomous agent: if the run is still working, or still waiting for a person, when the time is up, you get the run ID, its status and a link to it. For a workflow agent: the time limit on its one call; if it has not answered by then, the step fails. The limit only stops the waiting: the run may carry on in almyty, and running the node again starts a new run.',
				displayOptions: { show: { operation: ['runAgent'] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials(CREDENTIAL);
				const request: Request = (options: IHttpRequestOptions) =>
					this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, options);
				const agents = await listAgents(request, String(credentials.baseUrl));
				return agentOptions(agents);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials(CREDENTIAL);
		const request: Request = (options: IHttpRequestOptions) =>
			this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, options);

		for (let i = 0; i < items.length; i++) {
			try {
				const agentId = this.getNodeParameter('agentId', i) as string;
				const input = this.getNodeParameter('input', i) as string;
				const waitForResult = this.getNodeParameter('waitForResult', i, true) as boolean;
				const ifRunNeedsPerson = (
					waitForResult ? this.getNodeParameter('ifRunNeedsPerson', i, DEFAULT_IF_RUN_NEEDS_PERSON) : DEFAULT_IF_RUN_NEEDS_PERSON
				) as IfRunNeedsPerson;
				// Read with waiting off too: it is the time limit on a workflow
				// agent's one /invoke call either way.
				const maxWaitSeconds = this.getNodeParameter('maxWaitSeconds', i, DEFAULT_MAX_WAIT_MS / 1000) as number;

				const result = await runAgent(request, {
					baseUrl: String(credentials.baseUrl),
					appUrl: credentials.appUrl ? String(credentials.appUrl) : undefined,
					agentId,
					input,
					waitForResult,
					ifRunNeedsPerson,
					maxWaitMs: maxWaitSeconds * 1000,
					sleep,
				});
				returnData.push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				if (error instanceof RunFailedError) {
					if (this.continueOnFail()) {
						returnData.push({ json: error.result, pairedItem: { item: i } });
						continue;
					}
					throw new NodeOperationError(this.getNode(), `The agent run failed: ${error.message}`, {
						itemIndex: i,
						description: error.result.runUrl ? `See the run: ${String(error.result.runUrl)}` : undefined,
					});
				}
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message } as IDataObject,
						pairedItem: { item: i },
					});
					continue;
				}
				if ((error as { httpCode?: unknown; response?: unknown }).response !== undefined ||
					(error as { httpCode?: unknown }).httpCode !== undefined) {
					throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
