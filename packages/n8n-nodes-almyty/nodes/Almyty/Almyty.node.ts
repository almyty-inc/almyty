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
	DEFAULT_MAX_WAIT_MS,
	RunFailedError,
	agentOptions,
	listAgents,
	runAgent,
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
					'Whether to wait for the agent to finish and return its answer. Off returns the run ID and status straight away.',
				displayOptions: { show: { operation: ['runAgent'] } },
			},
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWaitSeconds',
				type: 'number',
				typeOptions: { minValue: 1 },
					default: 300,
				description:
					'How long to wait for the answer. If the agent is still working by then, you get the run ID and the status "running".',
				displayOptions: { show: { operation: ['runAgent'], waitForResult: [true] } },
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
				const maxWaitSeconds = waitForResult
					? (this.getNodeParameter('maxWaitSeconds', i, DEFAULT_MAX_WAIT_MS / 1000) as number)
					: 0;

				const result = await runAgent(request, {
					baseUrl: String(credentials.baseUrl),
					appUrl: credentials.appUrl ? String(credentials.appUrl) : undefined,
					agentId,
					input,
					waitForResult,
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
