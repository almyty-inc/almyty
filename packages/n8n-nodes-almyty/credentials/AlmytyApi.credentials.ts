import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class AlmytyApi implements ICredentialType {
	name = 'almytyApi';

	// The brand is written lowercase everywhere, in titles too.
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-miscased
	displayName = 'almyty API';

	// The mark carries its own dark tile, so one file reads on both themes.
	icon: Icon = { light: 'file:../icons/almyty.svg', dark: 'file:../icons/almyty.svg' };

	documentationUrl = 'https://github.com/almyty-inc/almyty/tree/development/packages/n8n-nodes-almyty#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.almyty.com',
			required: true,
			description: 'Where your almyty API lives. Change it only if you run almyty yourself.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'An almyty API key. Create one in almyty under Settings, API keys.',
		},
		{
			displayName: 'App URL',
			name: 'appUrl',
			type: 'string',
			default: '',
			placeholder: 'https://app.almyty.com',
			description:
				'Where people open almyty in the browser, used for links to runs. Leave empty to work it out from the base URL.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/agents',
			qs: { limit: 1 },
		},
	};
}
