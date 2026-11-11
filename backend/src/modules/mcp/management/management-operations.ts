/**
 * What the management MCP (`/:org/almyty`) covers of the platform's REST
 * routes, route by route. docs/design/almyty-mcp-coverage.md is generated
 * from this file (`npm run mcp:coverage`), and
 * __tests__/management-coverage.guard.spec.ts fails when a controller
 * route is in none of the four lists below, or in more than one.
 *
 *  - CURATED_TOOL_ROUTES: routes a hand-written management tool covers
 *    (almyty-mcp.service.ts). The tool's REST twin; its guards are what
 *    the tool authorizes against.
 *  - OPERATIONS: every other route a signed-in member can use, as an
 *    operation found with search_operations and run with
 *    call_read_operation / call_write_operation / call_destructive_operation.
 *    An operation is the route itself (route-invoker.service.ts).
 *  - EXCLUDED_ROUTES: routes an MCP client must not or cannot use, each
 *    with the reason. SECRET_OPERATIONS among them: a route whose purpose
 *    is a secret is never an operation (secret-arguments.ts).
 *  - HELD_ROUTES: routes left out until someone decides whether an MCP
 *    client may do this at all. Moving one into OPERATIONS is a product
 *    decision, not an engineering one.
 *
 * Routes are named `ControllerClass.handler`, which is how the guard
 * finds them in the source.
 */

export type OperationEffect = 'read' | 'write' | 'destructive';

export interface OperationEntry {
  /** `resource.action`, the name an MCP client calls it by. */
  name: string;
  /** `ControllerClass.handler`. */
  route: string;
  /** Default: GET reads, DELETE destroys, anything else writes. */
  effect?: OperationEffect;
  /** Default: the route's own @ApiOperation summary. */
  summary?: string;
  /** Reaches outside almyty: calls a model, a third party or a URL, or runs a tool or an agent. */
  openWorld?: boolean;
  /**
   * Fields the route takes that are secrets (a current password, a bearer
   * token): left out of the operation's schema and refused on call. The
   * rest of the route is the operation; the secret is set in the app.
   */
  secretFields?: string[];
  /** Argument paths whose name reads like a secret but is not one (a role's `key`), each with its reason in a comment. */
  notSecret?: string[];
  /** Argument paths that are a tool's or an agent's own input, handed to it as they are and not kept as almyty configuration. */
  passThrough?: string[];
  /** The app page a refused secret goes to instead (`:param` filled from the arguments). Default: /credentials/new. */
  secretPage?: string;
}

/** An operation's effect: the catalog's override, else what the HTTP method says. */
export function effectOf(entry: Pick<OperationEntry, 'effect'>, method: string): OperationEffect {
  if (entry.effect) return entry.effect;
  if (method === 'GET') return 'read';
  if (method === 'DELETE') return 'destructive';
  return 'write';
}

type Extra = Omit<OperationEntry, 'name' | 'route'>;
const op = (name: string, route: string, extra: Extra = {}): OperationEntry => ({ name, route, ...extra });
const READ: Extra = { effect: 'read' };
const OPEN: Extra = { openWorld: true };
/** The summary of an operation that mints a key: the key comes back once, in plaintext, as over REST. */
const KEY_ONCE = (what: string) =>
  `${what}. The key is shown only once: the answer holds it in full, in plaintext, exactly as the dashboard shows it. Copy it now; it cannot be read again.`;

/** Hand-written management tools and the REST routes each one is. */
export const CURATED_TOOL_ROUTES: Record<string, string[]> = {
  list_apis: ['ApisController.findAll'],
  create_api: ['ApisController.create'],
  update_api: ['ApisController.update'],
  import_schema: ['ApisController.importSchema'],
  check_import_status: ['ApisController.getImportStatus'],
  delete_api: ['ApisController.remove'],
  list_tools: ['ToolsController.getTools'],
  delete_tool: ['ToolsController.deleteTool'],
  activate_tool: ['ToolsController.activateTool'],
  list_gateways: ['GatewaysController.getGateways'],
  delete_gateway: ['GatewaysController.deleteGateway'],
  create_gateway: ['GatewaysController.createGateway'],
  assign_tools_to_gateway: ['GatewayToolsController.bulkAssociateTools'],
  add_auth_to_gateway: ['GatewayAuthController.createGatewayAuth'],
  remove_auth_from_gateway: ['GatewayAuthController.deleteGatewayAuth'],
  list_agents: ['AgentsController.getAgents'],
  create_agent: ['AgentsController.createAgent'],
  update_agent: ['AgentsController.updateAgent'],
  delete_agent: ['AgentsController.deleteAgent'],
  activate_agent: ['AgentsController.activateAgent'],
  deactivate_agent: ['AgentsController.deactivateAgent'],
  invoke_agent: ['AgentExecutionController.invokeAgent', 'AgentRunsController.startRun'],
  get_run: ['AgentRunsController.getRun'],
  answer_run: ['AgentRunsController.sendRunInput'],
  list_providers: ['LlmProvidersController.getProviders'],
  add_provider: ['LlmProvidersController.createProvider'],
  list_channels: ['AgentChannelsController.list'],
  add_channel: ['AgentChannelsController.add'],
  get_channel: ['AgentChannelsController.get'],
  check_channel: ['AgentChannelsController.check'],
  update_channel: ['AgentChannelsController.update'],
  delete_channel: ['AgentChannelsController.remove'],
  publish_channel: ['AgentChannelsController.publish'],
  unpublish_channel: ['AgentChannelsController.unpublish'],
  get_public_settings: ['AgentChannelsController.publicSettings'],
  update_public_settings: ['AgentChannelsController.updatePublicSettings'],
  build_channel: ['AgentChannelsController.requestBuild'],
  list_builds: ['AgentChannelsController.listBuilds'],
  memory_put: ['CanonicalMemoryController.put'],
  memory_search: ['CanonicalMemoryController.search'],
  memory_list: ['CanonicalMemoryController.list'],
  memory_get: ['CanonicalMemoryController.get'],
  memory_delete: ['CanonicalMemoryController.remove'],
  memory_supersede: ['CanonicalMemoryController.supersede'],
  memory_consolidate: ['CanonicalMemoryController.consolidate'],
  memory_transfer: ['CanonicalMemoryController.transfer'],
  memory_sync: ['CanonicalMemoryController.syncScope'],
  memory_list_backends: ['CanonicalMemoryController.listBackends'],
  memory_backends_health: ['CanonicalMemoryController.healthAll'],
  list_models: ['ModelCatalogController.list'],
  sync_models: ['ModelCatalogController.sync'],
  validate_model: ['ModelCatalogController.validate'],
  preview_model_routing: ['ModelCatalogController.routePreview'],
  list_model_deployments: ['ModelDeploymentsController.list'],
  list_model_versions: ['ModelVersionsController.list'],
  list_connectors: ['CredentialsController.listServices'],
  list_connections: ['CredentialsController.findAll'],
  start_connection: ['CredentialsController.connect'],
  complete_connection: ['CredentialsController.completeConnect'],
  list_connection_grants: ['GrantsController.list'],
  grant_connection: ['GrantsController.create'],
  list_credentials: ['CredentialsController.findAll'],
  list_runners: ['RunnerController.list', 'WorkspaceController.list'],
  list_org_members: ['OrganizationsController.getOrganizationMembers'],
  list_budgets: ['BudgetsController.list'],
  get_spend: ['BudgetsController.getSpend'],
  get_analytics: [
    'AnalyticsController.getOverview',
    'AnalyticsController.getToolUsage',
    'AnalyticsController.getGatewayUsage',
    'AnalyticsController.getLlmUsage',
    'AnalyticsController.getAgentRuns',
    'MonitoringController.getAlerts',
    'RoutingAnalyticsController.failureRate',
  ],
  list_tool_templates: ['ToolHubController.listTemplates'],
  install_tool_template: ['ToolHubController.installTemplate'],
  list_approvals: ['ApprovalsController.list'],
  decide_approval: ['ApprovalsController.approve', 'ApprovalsController.reject'],
};

/**
 * The route a curated tool authorizes against, when it is not the first
 * of its routes: the one the tool's arguments pick.
 */
export const CURATED_AUTHORIZATION: Record<string, (args: any) => string> = {
  get_analytics: (args) =>
    ({
      overview: 'AnalyticsController.getOverview',
      tools: 'AnalyticsController.getToolUsage',
      gateways: 'AnalyticsController.getGatewayUsage',
      models: 'AnalyticsController.getLlmUsage',
      agent_runs: 'AnalyticsController.getAgentRuns',
      alerts: 'MonitoringController.getAlerts',
      routing_failures: 'RoutingAnalyticsController.failureRate',
    })[String(args?.report)] ?? 'AnalyticsController.getOverview',
  decide_approval: (args) => (args?.decision === 'reject' ? 'ApprovalsController.reject' : 'ApprovalsController.approve'),
};

/** The path parameters a curated tool's arguments supply to its route's guards. */
export const CURATED_PARAMS: Record<string, (args: any) => Record<string, unknown>> = {
  update_api: (a) => ({ id: a.apiId }),
  import_schema: (a) => ({ id: a.apiId }),
  check_import_status: (a) => ({ id: a.apiId, jobId: a.jobId }),
  delete_api: (a) => ({ id: a.apiId }),
  delete_tool: (a) => ({ toolId: a.toolId }),
  activate_tool: (a) => ({ toolId: a.toolId ?? a.toolIds?.[0] }),
  delete_gateway: (a) => ({ gatewayId: a.gatewayId }),
  assign_tools_to_gateway: (a) => ({ gatewayId: a.gatewayId }),
  add_auth_to_gateway: (a) => ({ gatewayId: a.gatewayId }),
  remove_auth_from_gateway: (a) => ({ gatewayId: a.gatewayId, authId: a.authId }),
  update_agent: (a) => ({ id: a.agentId }),
  delete_agent: (a) => ({ id: a.agentId }),
  activate_agent: (a) => ({ id: a.agentId }),
  deactivate_agent: (a) => ({ id: a.agentId }),
  invoke_agent: (a) => ({ id: a.agentId }),
  get_run: (a) => ({ id: a.agentId, runId: a.runId }),
  answer_run: (a) => ({ id: a.agentId, runId: a.runId }),
  list_channels: (a) => ({ agentId: a.agentId }),
  add_channel: (a) => ({ agentId: a.agentId }),
  get_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  check_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  update_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  delete_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  publish_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  unpublish_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  get_public_settings: (a) => ({ agentId: a.agentId }),
  update_public_settings: (a) => ({ agentId: a.agentId }),
  build_channel: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  list_builds: (a) => ({ agentId: a.agentId, channelId: a.channelId }),
  memory_get: (a) => ({ id: a.id }),
  memory_delete: (a) => ({ id: a.id }),
  memory_supersede: (a) => ({ id: a.old_id }),
  validate_model: (a) => ({ id: a.modelId }),
  start_connection: (a) => ({ connectorKey: a.connectorKey }),
  complete_connection: (a) => ({ connectorKey: a.connectorKey }),
  list_connection_grants: (a) => ({ id: a.connectionId }),
  grant_connection: (a) => ({ id: a.connectionId }),
  install_tool_template: (a) => ({ id: a.templateId }),
  decide_approval: (a) => ({ id: a.approvalId }),
};

/** Every other route a signed-in member can use, as an MCP operation. */
export const OPERATIONS: OperationEntry[] = [
  // ── Agents ──
  op('agents.get', 'AgentsController.getAgent'),
  op('agents.list_templates', 'AgentsController.getTemplates'),
  op('agents.import', 'AgentsController.importAgent'),
  op('agents.get_readiness', 'AgentsController.getReadiness'),
  op('agents.duplicate', 'AgentsController.duplicateAgent'),
  op('agents.list_executions', 'AgentManagementController.getAgentExecutions'),
  op('agents.get_audit_log', 'AgentManagementController.getAuditLog'),
  op('agents.save_version', 'AgentManagementController.saveVersion'),
  op('agents.list_versions', 'AgentManagementController.getVersionHistory'),
  op('agents.rollback_to_version', 'AgentManagementController.rollbackToVersion'),
  op('agents.export', 'AgentManagementController.exportAgent'),
  op('agents.get_technical_documentation', 'AgentManagementController.getTechnicalDocumentation'),
  op('agents.get_cost_estimate', 'AgentManagementController.getCostEstimate'),
  op('agents.get_api_access', 'AgentApiAccessController.get'),
  op('agents.set_api_access', 'AgentApiAccessController.set'),
  op('agents.get_execution_settings', 'AgentExecutionSettingsController.get'),
  op('agents.update_execution_settings', 'AgentExecutionSettingsController.put'),
  op('agents.eject_execution_settings', 'AgentExecutionSettingsController.eject'),
  op('agents.list_roles', 'AgentRolesController.list'),
  // A role's `key` is its name on the agent (planner, verifier), not a secret.
  op('agents.upsert_role', 'AgentRolesController.upsert', { notSecret: ['body.key'] }),
  op('agents.remove_role', 'AgentRolesController.remove', { notSecret: ['key'] }),
  op('agents.resolve_roles', 'AgentRolesController.resolve', READ),
  op('agents.list_constraints', 'AgentConstraintsController.list'),
  op('agents.add_constraint', 'AgentConstraintsController.add'),
  op('agents.set_constraint_active', 'AgentConstraintsController.setActive'),
  op('agents.remove_constraint', 'AgentConstraintsController.remove'),
  op('agents.list_model_issues', 'ModelCatalogController.agentIssues'),
  op('agents.list_strategies', 'StrategiesController.list'),
  // ── Runs ──
  op('runs.get_execution_trace', 'AgentRunsController.trace'),
  op('runs.list', 'AgentRunsController.listRuns'),
  op('runs.list_code_executions', 'AgentRunsController.listCodeExecutions'),
  op('runs.get_code_execution', 'AgentRunsController.getCodeExecution'),
  op('runs.cancel', 'AgentRunsController.cancelRun'),
  // ── Schedules and always-on ──
  op('schedules.get', 'AgentScheduleController.getSchedule'),
  op('schedules.preview', 'AgentScheduleController.previewSchedule', READ),
  op('schedules.list_destinations', 'AgentScheduleController.destinations'),
  op('schedules.update', 'AgentScheduleController.updateSchedule'),
  op('schedules.set', 'AgentScheduleController.scheduleAgent'),
  op('schedules.remove', 'AgentScheduleController.unscheduleAgent'),
  op('always_on.get', 'AlwaysOnController.get'),
  op('always_on.update', 'AlwaysOnController.update'),
  op('always_on.wake_now', 'AlwaysOnController.wakeNow', OPEN),
  op('always_on.list_wakes', 'AlwaysOnController.wakes'),
  op('push_wakes.list', 'PushWakesController.list'),
  op('push_wakes.list_options', 'PushWakesController.options'),
  op('push_wakes.list_operations', 'PushWakesController.operations'),
  op('push_wakes.create', 'PushWakesController.create', OPEN),
  op('push_wakes.update', 'PushWakesController.update'),
  op('push_wakes.resubscribe', 'PushWakesController.resubscribe', OPEN),
  op('push_wakes.remove', 'PushWakesController.remove'),
  // ── Channels ──
  op('channels.get_spend', 'AgentChannelsController.spend'),
  op('channels.lookup_visitor_data', 'AgentChannelsController.lookupVisitorData', READ),
  op('channels.export_visitor_data', 'AgentChannelsController.exportVisitorData', READ),
  op('channels.erase_visitor_data', 'AgentChannelsController.eraseVisitorData', { effect: 'destructive' }),
  op('channels.record_build', 'AgentChannelsController.recordBuild'),
  op('channels.list_platforms', 'AgentChannelsController.platforms'),
  op('channels.get_capabilities', 'AgentChannelsController.capabilities'),
  op('channels.get_build_download_link', 'AgentChannelsController.download'),
  op('channels.list_events', 'ChannelEventsController.listEvents'),
  op('channels.test_connection', 'ChannelEventsController.testConnection', OPEN),
  op('channels.list_installations', 'ChannelInstallationsController.listInstallations'),
  op('channels.revoke_installation', 'ChannelInstallationsController.revokeInstallation', { effect: 'destructive', openWorld: true }),
  op('channels.get_custom_domain', 'CustomDomainController.get'),
  op('channels.set_custom_domain', 'CustomDomainController.set'),
  op('channels.verify_custom_domain', 'CustomDomainController.verify', OPEN),
  op('channels.remove_custom_domain', 'CustomDomainController.remove'),
  op('channels.get_visitor_sign_in', 'VisitorOAuthConfigController.get'),
  op('channels.remove_visitor_sign_in', 'VisitorOAuthConfigController.remove'),
  op('channels.get_managing_channel', 'ChannelLinkController.managedBy'),
  op('channels.get_hosted_chat_sso', 'HostedChatSsoSettingsController.get'),
  // ── External agents ──
  op('external_agents.preview', 'ExternalAgentsController.preview', { effect: 'read', openWorld: true }),
  op('external_agents.add', 'ExternalAgentsController.create', OPEN),
  op('external_agents.list', 'ExternalAgentsController.findAll'),
  op('external_agents.get', 'ExternalAgentsController.findOne'),
  op('external_agents.update', 'ExternalAgentsController.update'),
  op('external_agents.remove', 'ExternalAgentsController.remove'),
  op('external_agents.refresh', 'ExternalAgentsController.refresh', OPEN),
  // ── Skills promoted from runs ──
  op('promoted_skills.promote', 'PromotedSkillsController.promote'),
  op('promoted_skills.list', 'PromotedSkillsController.list'),
  op('promoted_skills.get', 'PromotedSkillsController.get'),
  op('promoted_skills.get_skill_md', 'PromotedSkillsController.raw'),
  op('promoted_skills.remove', 'PromotedSkillsController.remove'),
  op('promoted_skills.replay', 'PromotedSkillReplayController.replay', { ...OPEN, passThrough: ['body.input'] }),
  // ── APIs ──
  op('apis.connect', 'ApisController.connect', { ...OPEN, summary: 'Connect an API in one call from a schema URL or pasted schema content; the import runs in the background. (A file upload is the dashboard\'s; over MCP pass the URL or the content.)' }),
  op('apis.create_http', 'ApisController.createHttpApi'),
  op('apis.create_sdk', 'ApisController.createSdkApi'),
  op('apis.analyse_sdk', 'ApisController.analyseSdk'),
  op('apis.get_sdk_maps', 'ApisController.getSdkMaps'),
  op('apis.get', 'ApisController.findOne'),
  op('apis.generate_tools', 'ApisController.generateTools'),
  op('apis.list_operations', 'ApisController.getOperations'),
  op('apis.get_operation_outline', 'ApisController.getOperationOutline'),
  op('apis.select_operations', 'ApisController.selectOperations'),
  op('apis.list_resources', 'ApisController.getResources'),
  op('apis.test_connection', 'ApisController.testConnection', OPEN),
  op('apis.list_schemas', 'ApisController.getSchemas'),
  op('apis.get_parsed_schema', 'ApisController.getParsedSchema'),
  op('apis.set_status', 'ApisController.updateStatus'),
  op('apis.get_key', 'ApisCredentialsController.getKey'),
  op('apis.remove_key', 'ApisCredentialsController.removeKey'),
  op('apis.list_credentials', 'ApisCredentialsController.getCredentials'),
  op('apis.remove_credential', 'ApisCredentialsController.deleteCredential'),
  op('apis.test_credential', 'ApisCredentialsController.testCredential', { effect: 'read', openWorld: true }),
  // ── Tools ──
  op('tools.create', 'ToolsController.createTool', { summary: 'Write a tool by hand: an HTTP request, JavaScript code, a GraphQL query or an LLM prompt. Its credentials come from a stored credential (credentialId); a secret in its auth or headers is refused.' }),
  op('tools.update', 'ToolsController.updateTool', { summary: "Change a tool's definition: its request, code, prompt, parameters or auth. A secret in its auth or headers is refused; point it at a stored credential instead." }),
  op('tools.search', 'ToolsController.searchTools', READ),
  op('tools.get_signature', 'ToolsController.toolSignature'),
  op('tools.get', 'ToolsController.getTool'),
  op('tools.deactivate', 'ToolsController.deactivateTool'),
  op('tools.execute', 'ToolsController.executeTool', { ...OPEN, passThrough: ['body.parameters'] }),
  op('tools.list_versions', 'ToolsController.getToolVersions'),
  op('tools.get_stats', 'ToolsController.getToolStats'),
  op('tools.generate_from_api', 'ToolsController.generateToolsFromApi'),
  op('tools.regenerate', 'ToolsController.regenerateTool'),
  op('tools.get_overview_stats', 'ToolsController.getOrganizationStats'),
  op('tools.export_skill', 'ToolsExportController.getToolSkill'),
  op('tools.export_cli', 'ToolsExportController.getToolCli'),
  op('tools.export_sdk', 'ToolsExportController.getToolSdk'),
  op('mcp_sources.add', 'McpSourcesController.create', { ...OPEN, secretFields: ['body.bearerToken'] }),
  op('mcp_sources.list', 'McpSourcesController.findAll'),
  op('mcp_sources.get', 'McpSourcesController.findOne'),
  op('mcp_sources.sync', 'McpSourcesController.sync', OPEN),
  op('mcp_sources.remove', 'McpSourcesController.remove'),
  // ── Tool hub ──
  op('tool_hub.list_providers', 'ToolHubController.getProviders'),
  op('tool_hub.list_categories', 'ToolHubController.getCategories'),
  op('tool_hub.get_template', 'ToolHubController.getTemplate'),
  op('tool_hub.install_provider_templates', 'ToolHubController.installProviderTemplates', OPEN),
  op('tool_hub.publish_template', 'ToolHubController.publishTemplate'),
  op('tool_hub.update_template', 'ToolHubController.updateTemplate'),
  op('tool_hub.delete_template', 'ToolHubController.deleteTemplate'),
  // ── Gateways ──
  op('gateways.get', 'GatewaysController.getGateway'),
  op('gateways.update', 'GatewaysController.updateGateway', { summary: "Change a gateway: its name, address, protocol settings, rate limits, CORS, webhooks, custom headers or health check. A published gateway changes at once for everyone who calls it. A secret in its headers or configuration is refused." }),
  op('gateways.activate', 'GatewaysController.activateGateway'),
  op('gateways.deactivate', 'GatewaysController.deactivateGateway'),
  op('gateways.add_tool', 'GatewayToolsController.associateTool'),
  op('gateways.remove_tool', 'GatewayToolsController.removeToolFromGateway'),
  op('gateways.update_tool', 'GatewayToolsController.updateGatewayTool'),
  op('gateways.remove_all_tools', 'GatewayToolsController.removeAllToolsFromGateway'),
  op('gateways.list_tools', 'GatewayToolsController.getGatewayTools'),
  op('gateways.list_available_tools', 'GatewayToolsController.getAvailableTools'),
  op('gateways.get_tool_stats', 'GatewayToolsController.getGatewayToolStats'),
  op('gateways.get_company_sign_in_metadata', 'GatewayAuthController.companyMetadata'),
  op('gateways.list_auth', 'GatewayAuthController.getGatewayAuths'),
  op('gateways.update_auth', 'GatewayAuthController.updateGatewayAuth'),
  op('gateways.list_api_keys', 'GatewayAuthController.listGatewayApiKeys'),
  op('gateways.create_api_key', 'GatewayAuthController.generateGatewayApiKey', { summary: KEY_ONCE('Create an API key for a gateway') }),
  op('gateways.revoke_api_key', 'GatewayAuthController.revokeGatewayApiKey'),
  op('gateways.search_skills', 'GatewayInfoController.searchSkills'),
  op('gateways.list_all_skills', 'GatewayInfoController.getAllSkills'),
  op('gateways.get_stats', 'GatewayInfoController.getGatewayStats'),
  op('gateways.health_check', 'GatewayInfoController.performHealthCheck', OPEN),
  op('gateways.get_overview_stats', 'GatewayInfoController.getOrganizationStats'),
  op('gateways.resolve', 'GatewayInfoController.resolveGateway'),
  op('gateways.get_skills', 'GatewaySkillsController.getGatewaySkills'),
  op('gateways.list_skills', 'GatewaySkillsController.getGatewayIndividualSkills'),
  // A tool's parameters go to the tool as they are (a `pageToken` is the tool's, not almyty's).
  op('gateways.execute_skill', 'GatewaySkillsController.executeSkill', { ...OPEN, passThrough: ['body.parameters'] }),
  op('gateways.run_code', 'GatewaySkillsController.runCode', OPEN),
  op('gateways.get_cli_bundle', 'GatewaySkillsController.getGatewayCliBundle'),
  op('gateways.get_sdk', 'GatewaySkillsController.getGatewaySdk'),
  // ── Credentials and connections ──
  // A connector's `key` is its name in the catalog, not a secret.
  op('credentials.add_connector', 'CredentialsController.createService', { notSecret: ['body.key'] }),
  op('credentials.get', 'CredentialsController.findById'),
  op('credentials.delete', 'CredentialsController.delete'),
  op('credentials.check', 'CredentialsController.validate', OPEN),
  op('credentials.set_sharing', 'CredentialsController.setSharing'),
  op('credentials.get_usage', 'CredentialsController.getUsage'),
  op('credentials.list_access_keys', 'CredentialsController.findAllAccessKeys'),
  op('credentials.create_access_key', 'CredentialsController.createAccessKey', { summary: KEY_ONCE('Create an organization access key') }),
  op('credentials.revoke_access_key', 'CredentialsController.revokeAccessKey'),
  op('credentials.revoke_grant', 'GrantsController.revoke'),
  op('credentials.list_oauth_presets', 'OAuth2Controller.getPresets'),
  op('credentials.get_oauth_callback_url', 'OAuth2Controller.getCallbackUrl'),
  // ── Providers and models ──
  // A provider's API key is added in the app; a keyless provider (Ollama) connects here.
  op('providers.connect', 'LlmProvidersController.connectProvider', { ...OPEN, secretPage: '/models/providers/new' }),
  op('providers.list_types', 'LlmProvidersController.getProviderTypes'),
  op('providers.get', 'LlmProvidersController.getProvider'),
  op('providers.get_usage', 'LlmProvidersController.getProviderUsage'),
  op('providers.update', 'LlmProvidersController.updateProvider', { secretPage: '/models/providers/:id' }),
  op('providers.list_agents_using', 'LlmProvidersController.agentsUsingProvider'),
  op('providers.delete', 'LlmProvidersController.deleteProvider'),
  op('providers.chat', 'LlmProvidersController.chat', OPEN),
  op('providers.test', 'LlmProvidersController.performHealthCheck', OPEN),
  op('providers.list_models_by_type', 'LlmProvidersController.getModelsByType', { effect: 'read', openWorld: true }),
  op('providers.test_connection', 'LlmProvidersController.testConnection', { effect: 'read', openWorld: true }),
  op('providers.list_models', 'LlmProvidersController.getProviderModels', OPEN),
  op('providers.create_session', 'LlmSessionsController.createSession'),
  op('providers.list_sessions', 'LlmSessionsController.getSessions'),
  op('providers.get_session', 'LlmSessionsController.getSession'),
  op('providers.update_session', 'LlmSessionsController.updateSession'),
  op('providers.delete_session', 'LlmSessionsController.deleteSession'),
  op('provider_usage.list_capabilities', 'ProviderUsageController.getCapabilities'),
  op('provider_usage.reconciliation', 'ProviderUsageController.reconciliation'),
  op('provider_usage.sync', 'ProviderUsageController.sync', OPEN),
  op('models.register', 'ModelCatalogController.register'),
  op('models.get', 'ModelCatalogController.get'),
  op('models.update', 'ModelCatalogController.update'),
  op('models.remove', 'ModelCatalogController.remove'),
  op('model_deployments.list_adapters', 'ModelDeploymentsController.listAdapters'),
  op('model_deployments.get', 'ModelDeploymentsController.get'),
  op('model_deployments.create', 'ModelDeploymentsController.create', OPEN),
  op('model_deployments.scale', 'ModelDeploymentsController.scale', OPEN),
  op('model_deployments.tear_down', 'ModelDeploymentsController.teardown', { effect: 'destructive', openWorld: true }),
  op('model_deployments.remove', 'ModelDeploymentsController.remove'),
  op('model_versions.register', 'ModelVersionsController.register'),
  op('model_versions.get', 'ModelVersionsController.get'),
  op('model_versions.remove', 'ModelVersionsController.remove'),
  // ── Memory ──
  op('memory.list_accounts', 'CanonicalMemoryController.listAccounts'),
  op('memory.get_config', 'CanonicalMemoryController.getConfig'),
  op('memory.update_config', 'CanonicalMemoryController.updateConfig'),
  op('memory.list_softcap_warnings', 'CanonicalMemoryController.listSoftcapWarnings'),
  op('memory.import_document', 'CanonicalMemoryController.importDocument'),
  op('memory.accounts_overview', 'CanonicalMemoryController.accountsOverview'),
  op('memory.list_moves', 'CanonicalMemoryController.listMoves'),
  op('memory.list_move_agents', 'CanonicalMemoryController.moveAgents'),
  op('memory.get_move', 'CanonicalMemoryController.getMove'),
  op('memory.start_move', 'CanonicalMemoryController.startMove'),
  op('memory.resume_move', 'CanonicalMemoryController.resumeMove'),
  // ── Runners, workspaces, hosted environments ──
  op('runners.create', 'RunnerController.create'),
  op('runners.get', 'RunnerController.getOne'),
  op('runners.update', 'RunnerController.update'),
  op('runners.remove', 'RunnerController.unregister'),
  op('runners.list_agents', 'RunnerController.agentList'),
  // apiKeyEnvVar names an environment variable; it holds no key.
  op('runners.spawn_agent', 'RunnerController.agentSpawn', { ...OPEN, secretFields: ['body.apiKey'], notSecret: ['body.apiKeyEnvVar'] }),
  op('runners.get_agent_status', 'RunnerController.agentStatus', READ),
  op('runners.list_coding_agents', 'RunnerController.codingAgents'),
  op('runners.start_coding_session', 'RunnerController.codingStart', OPEN),
  op('runners.get_coding_session', 'RunnerController.codingStatus'),
  op('runners.send_coding_input', 'RunnerController.codingInput', OPEN),
  op('runners.stop_coding_session', 'RunnerController.codingStop'),
  op('workspaces.create', 'WorkspaceController.create'),
  op('workspaces.get', 'WorkspaceController.getOne'),
  op('workspaces.release', 'WorkspaceController.release'),
  op('environments.list', 'EnvironmentsController.list'),
  op('environments.get_settings', 'EnvironmentsController.settings'),
  op('environments.get_usage', 'EnvironmentsController.usage'),
  op('environments.create', 'EnvironmentsController.create'),
  op('environments.get', 'EnvironmentsController.get'),
  op('environments.update', 'EnvironmentsController.update'),
  op('environments.remove', 'EnvironmentsController.remove'),
  op('environments.list_runs', 'EnvironmentsController.runs'),
  op('environments.list_workspaces', 'EnvironmentsController.workspaces'),
  op('environments.suspend_workspace', 'EnvironmentsController.suspend'),
  op('environments.release_workspace', 'EnvironmentsController.release', { effect: 'destructive' }),
  // ── Approvals ──
  op('approvals.get', 'ApprovalsController.get'),
  op('approval_rules.list', 'AmountRulesController.list'),
  op('approval_rules.get', 'AmountRulesController.get'),
  op('approval_rules.create', 'AmountRulesController.create'),
  op('approval_rules.update', 'AmountRulesController.update'),
  op('approval_rules.remove', 'AmountRulesController.remove'),
  op('approval_policies.list', 'ApprovalPoliciesController.list'),
  op('approval_policies.create', 'ApprovalPoliciesController.create'),
  op('approval_policies.get', 'ApprovalPoliciesController.get'),
  op('approval_policies.update', 'ApprovalPoliciesController.update'),
  op('approval_policies.remove', 'ApprovalPoliciesController.remove'),
  // ── Cost: budgets, chargeback ──
  op('budgets.list_alerts', 'BudgetsController.listAlerts'),
  op('budgets.get', 'BudgetsController.get'),
  op('budgets.create', 'BudgetsController.create'),
  op('budgets.update', 'BudgetsController.update'),
  op('budgets.remove', 'BudgetsController.remove'),
  op('chargeback.get_report', 'ChargebackController.getReport'),
  // ── Analytics, monitoring, notifications ──
  op('analytics.list_requests', 'AnalyticsController.getRequestLogs'),
  op('analytics.get_script_usage', 'AnalyticsController.getScriptUsage'),
  op('analytics.get_timeline', 'AnalyticsController.getTimeline'),
  op('analytics.get_audit_summary', 'AnalyticsController.getAuditSummary'),
  op('analytics.export', 'AnalyticsController.exportLogs'),
  op('monitoring.resolve_alert', 'MonitoringController.resolveAlert'),
  op('monitoring.get_live_stats', 'MonitoringController.getLiveStats'),
  op('monitoring.get_enterprise_dashboard', 'MonitoringController.getEnterpriseDashboard'),
  op('notifications.list', 'NotificationsController.list'),
  op('notifications.get_preferences', 'NotificationsController.getPreferences'),
  op('notifications.update_preferences', 'NotificationsController.updatePreferences'),
  op('notifications.mark_all_read', 'NotificationsController.readAll'),
  op('notifications.mark_read', 'NotificationsController.read'),
  // ── Audit and versions ──
  op('audit.list', 'AuditLogController.findAll'),
  op('audit.get_resource_history', 'AuditLogController.getResourceHistory'),
  op('audit.export', 'AuditExportController.download'),
  op('audit.list_streams', 'AuditExportController.listStreams'),
  op('audit.create_stream', 'AuditExportController.createStream', { secretFields: ['body.token'], secretPage: '/settings/audit-streams' }),
  op('audit.update_stream', 'AuditExportController.updateStream', { secretFields: ['body.token'], secretPage: '/settings/audit-streams' }),
  op('audit.delete_stream', 'AuditExportController.deleteStream'),
  op('versions.get', 'VersionsController.getVersion'),
  op('versions.list', 'VersionsController.getVersions'),
  // ── Files ──
  op('files.list', 'FilesController.findAll'),
  op('files.get', 'FilesController.findById'),
  op('files.remove', 'FilesController.remove'),
  // ── Organization, teams, members ──
  op('organization.list_mine', 'OrganizationsController.getUserOrganizations'),
  op('organization.create', 'OrganizationsController.createOrganization', { summary: 'Create another organization, with you as its owner. This MCP connection stays on the organization it was opened for.' }),
  op('organization.get', 'OrganizationsController.getOrganization'),
  op('organization.update', 'OrganizationsController.updateOrganization'),
  op('organization.delete', 'OrganizationsController.deleteOrganization', { summary: 'Delete this organization and everything in it (owners only). It cannot be undone.' }),
  op('organization.list_pending_invites', 'OrganizationsController.listPendingInvites'),
  op('members.invite', 'OrganizationsController.inviteUserToOrganization', { summary: 'Invite someone into the organization by email, with an organization role. They get an email to accept.' }),
  op('members.revoke_invite', 'OrganizationsController.revokePendingInvite'),
  op('members.update_role', 'OrganizationsController.updateMemberRole', { summary: "Change a member's organization role. body: { role: 'viewer' | 'member' | 'admin' | 'owner' }." }),
  op('members.remove', 'OrganizationsController.removeMember', { summary: 'Remove a member from the organization. They lose access at once.' }),
  op('teams.list', 'OrganizationsController.getOrganizationTeams'),
  op('teams.create', 'OrganizationsController.createTeam'),
  op('teams.update', 'OrganizationsController.updateTeam'),
  op('teams.delete', 'OrganizationsController.deleteTeam'),
  op('teams.list_members', 'OrganizationsController.getTeamMembers'),
  op('teams.add_member', 'OrganizationsController.addMemberToTeam'),
  op('teams.update_member_role', 'OrganizationsController.updateTeamMemberRole'),
  op('teams.remove_member', 'OrganizationsController.removeMemberFromTeam'),
  op('organization.get_onboarding', 'OnboardingController.getOnboarding'),
  op('organization.update_onboarding', 'OnboardingController.patchOnboarding'),
  op('organization.get_retention', 'RetentionController.getRetentionPolicy'),
  // Every window can only be set through the destructive call: a shorter
  // one deletes older data on the next sweep.
  op('organization.update_retention', 'RetentionController.updateRetentionPolicy', { effect: 'destructive', summary: 'Set how long runs, logs, audit entries and memory are kept. A shorter window deletes everything older on the next retention sweep, so this runs through call_destructive_operation.' }),
  op('organization.get_entitlements', 'LicensingController.getEntitlements'),
  op('users.list', 'UsersController.findAll'),
  op('users.search', 'UsersController.searchUsers'),
  op('users.get_me', 'UsersController.getCurrentUser'),
  op('users.get_my_activity', 'UsersController.getCurrentUserActivity'),
  op('users.get', 'UsersController.findOne'),
  op('users.update_me', 'UsersController.updateCurrentUser', { secretFields: ['body.currentPassword'], secretPage: '/settings/security' }),
  op('users.get_stats', 'UsersController.getUserStats'),
  op('users.get_activity', 'UsersController.getUserActivity'),
  op('users.update', 'UsersController.update', { secretFields: ['body.currentPassword'], secretPage: '/settings/security', summary: "Change another member's account in this organization (name, email, profile); admins and owners. Your own password is never an argument." }),
  op('users.deactivate', 'UsersController.deactivate', { summary: 'Deactivate a user account: they can no longer sign in until reactivated. Their data stays.' }),
  op('users.reactivate', 'UsersController.reactivate'),
  op('users.delete', 'UsersController.remove', { summary: 'Delete a user account (owners only). It cannot be undone.' }),
  op('profile.get', 'AuthController.getProfile'),
  op('profile.update', 'AuthController.updateProfile', { secretFields: ['body.currentPassword'], secretPage: '/settings/security' }),
  op('profile.list_api_keys', 'AuthController.getApiKeys'),
  op('profile.create_api_key', 'AuthController.createApiKey', { summary: KEY_ONCE('Create a platform API key for yourself') }),
  op('profile.revoke_api_key', 'AuthController.revokeApiKey'),
  op('referrals.get_code', 'ReferralsController.getCode'),
  op('referrals.get_stats', 'ReferralsController.getStats'),
  op('referrals.list', 'ReferralsController.list'),
  // ── Enterprise: roles and policies, SSO, compliance, governance, billing ──
  op('rbac.list_permissions', 'RbacController.listPermissions'),
  op('rbac.list_roles', 'RbacController.listRoles'),
  op('rbac.create_role', 'RbacController.createRole'),
  op('rbac.get_role', 'RbacController.getRole'),
  op('rbac.update_role', 'RbacController.updateRole'),
  op('rbac.delete_role', 'RbacController.deleteRole'),
  op('rbac.assign_role', 'RbacController.assign'),
  op('rbac.unassign_role', 'RbacController.unassign'),
  op('rbac.get_effective_permissions', 'RbacController.effective'),
  op('rbac.list_policies', 'RbacController.listPolicies'),
  op('rbac.create_policy', 'RbacController.createPolicy'),
  op('rbac.delete_policy', 'RbacController.deletePolicy'),
  op('sso.get_settings', 'SsoConfigController.get'),
  op('sso.update_settings', 'SsoConfigController.upsert', { secretPage: '/settings/sso', summary: "Create or change how members sign in with single sign-on (SAML or OIDC). The identity provider's client secret is added in the app; one in the arguments is refused." }),
  op('sso.list_domains', 'SsoConfigController.listDomains'),
  op('sso.add_domain', 'SsoConfigController.addDomain', { summary: 'Add an email domain for single sign-on (body.domain). It counts once its DNS TXT record is verified with sso.verify_domain.' }),
  op('sso.verify_domain', 'SsoConfigController.verifyDomain', OPEN),
  op('sso.remove_domain', 'SsoConfigController.removeDomain'),
  op('compliance.get_policy', 'ComplianceController.getPolicy'),
  op('compliance.set_policy', 'ComplianceController.upsertPolicy'),
  op('compliance.get_report', 'ComplianceController.getReport'),
  op('connection_governance.list_policies', 'ConnectionsGovernanceController.listPolicies'),
  op('connection_governance.create_policy', 'ConnectionsGovernanceController.createPolicy'),
  op('connection_governance.get_policy', 'ConnectionsGovernanceController.getPolicy'),
  op('connection_governance.update_policy', 'ConnectionsGovernanceController.updatePolicy'),
  op('connection_governance.remove_policy', 'ConnectionsGovernanceController.removePolicy'),
  op('connection_governance.review', 'ConnectionsGovernanceController.review'),
  op('connection_governance.revoke_grants', 'ConnectionsGovernanceController.revokeGrants', { effect: 'destructive' }),
  op('connection_governance.list_expiring', 'ConnectionsGovernanceController.expiring'),
  op('connection_governance.enforce_expiry', 'ConnectionsGovernanceController.enforceExpiry', { effect: 'destructive' }),
  op('connection_governance.list_rotation_due', 'ConnectionsGovernanceController.rotationCandidates'),
  op('connection_governance.rotate_due', 'ConnectionsGovernanceController.rotateDue', OPEN),
  op('connection_governance.sync_principals', 'ConnectionsGovernanceController.syncPrincipals'),
  op('connection_governance.export_audit', 'ConnectionsGovernanceController.auditExport'),
  op('billing.get_status', 'BillingController.getStatus'),
  op('billing.list_invoices', 'BillingController.listInvoices'),
  op('billing.create_checkout', 'BillingController.createCheckout', { ...OPEN, summary: 'Start a paid-plan checkout. Returns the Stripe checkout URL: open it to pay; nothing is charged until the person completes it there.' }),
  op('billing.open_portal', 'BillingController.createPortal', { ...OPEN, summary: 'Open the billing portal (payment methods, invoices, cancellation). Returns the Stripe portal URL to open.' }),
  op('kms.get', 'KmsController.get'),
  op('kms.set_key', 'KmsController.setCmk', { ...OPEN, summary: "Attach the organization's customer-managed key (an AWS KMS key ARN and region): a fresh data key is wrapped under it. Refused when a key is already attached; replacing one is kms.rotate_key. A key almyty cannot use locks the organization out of its own secrets." }),
  op('kms.rotate_key', 'KmsController.rotate', { ...OPEN, summary: 'Rotate onto a fresh data key, optionally under a different customer-managed key. The outgoing data key is kept, so secrets sealed under it stay readable.' }),
  // One route turns envelope encryption on and off; turning it off is
  // destructive, so both run through call_destructive_operation.
  op('kms.set_enabled', 'KmsController.setEnabled', { effect: 'destructive', summary: 'Turn bring-your-own-key encryption on or off (body.enabled). Turning it off stops sealing new secrets under your key, so this runs through call_destructive_operation either way.' }),
];

/** Routes an MCP client must not or cannot use, and why. */
export const EXCLUDED_ROUTES: Record<string, string> = {};

const exclude = (reason: string, routes: string[]) => {
  for (const route of routes) EXCLUDED_ROUTES[route] = reason;
};

exclude('Sign-in, sign-up and session handling: an MCP client is already signed in through the MCP OAuth flow and must not create, refresh or end sessions, or handle passwords and email verification.', [
  'AuthController.checkOrganizationName',
  'AuthController.register',
  'AuthController.login',
  'AuthController.token',
  'AuthController.refresh',
  'AuthController.logout',
  'AuthController.revokeOtherSessions',
  'AuthController.forgotPassword',
  'AuthController.resetPassword',
  'AuthController.changePassword',
  'AuthController.verifyEmail',
  'AuthController.verifyEmailLink',
  'AuthController.resendVerification',
  'AuthController.resendVerificationByEmail',
  'InvitesController.getMembershipInvite',
  'InvitesController.acceptMembershipInvite',
  'InvitesController.getInviteDetails',
  'InvitesController.acceptInvite',
  'ReferralsController.attribute',
]);
exclude('Single sign-on browser flow (redirects, IdP callbacks, SAML posts): run by a browser and an identity provider, not by an MCP client.', [
  'SsoController.discover',
  'SsoController.samlLogin',
  'SsoController.samlCallback',
  'SsoController.samlComplete',
  'SsoController.samlMetadata',
  'SsoController.oidcLogin',
  'SsoController.oidcCallback',
]);
exclude('SCIM provisioning: authenticated by the organization\'s SCIM token and called by its identity provider, not by a signed-in user.', [
  'ScimController.createUser',
  'ScimController.listUsers',
  'ScimController.getUser',
  'ScimController.replaceUser',
  'ScimController.patchUser',
  'ScimController.deleteUser',
  'ScimController.createGroup',
  'ScimController.listGroups',
  'ScimController.getGroup',
  'ScimController.patchGroup',
  'ScimController.deleteGroup',
]);
exclude('Returns the SCIM bearer token in plaintext: the credential the identity provider provisions with, set up in the app together with the provider, not a key for the MCP client.', [
  'SsoConfigController.rotateScimToken',
  'SsoConfigController.revealScimToken',
]);
exclude('OAuth redirect callback or OAuth client document: reached by a browser coming back from a provider, or fetched by the provider itself.', [
  'CredentialSignInController.clientMetadata',
  'CredentialSignInController.callback',
  'OAuth2Controller.callback',
  'ChannelInstallController.installSlack',
  'ChannelInstallController.installSlackCallback',
  'CompanySigninController.start',
  'CompanySigninController.callback',
  'CompanySigninController.approve',
]);
exclude('Public endpoint for visitors of a published chat, widget or hosted-chat page: what an agent\'s channel serves, not organization management.', [
  'HostedChatSsoController.login',
  'HostedChatSsoController.callback',
  'HostedChatSsoController.samlAcs',
  'HostedChatSsoController.samlComplete',
  'HostedChatEmailAuthController.start',
  'HostedChatEmailAuthController.verify',
  'HostedChatOAuthController.login',
  'HostedChatOAuthController.callback',
  'HostedChatController.byHost',
  'HostedChatController.branding',
  'HostedChatController.me',
  'HostedChatController.deleteConversation',
  'HostedChatController.deleteMe',
  'HostedChatController.exportMe',
  'HostedChatController.listConversations',
  'HostedChatController.uploadAttachment',
  'HostedChatController.postMessage',
  'HostedChatController.stream',
  'HostedChatController.messages',
  'ChannelWidgetController.widgetScript',
  'ChannelWidgetController.widgetPreview',
  'ChannelWidgetController.widgetPreviewScript',
  'ChannelWidgetController.widgetConfig',
  'ChannelWidgetController.uploadAttachment',
  'ChannelWidgetController.postMessage',
  'ChannelWidgetController.listMessages',
  'ChannelWidgetController.streamReply',
  'ChannelWidgetController.exportThread',
  'ChannelWidgetController.deleteThread',
]);
exclude('Inbound webhook from a third party (Stripe, an email provider, a push-wake subscription): authenticated by the sender\'s signature, not by a user.', [
  'BillingWebhookController.handleWebhook',
  'ChannelEmailInboundController.inbound',
  'PushWakeReceiverController.receive',
]);
exclude('A protocol endpoint itself (MCP, A2A, UTCP, OAuth for MCP clients, the OpenAI- and Anthropic-compatible APIs): the MCP client already speaks to agents and gateways through these, and invoke_agent runs an agent.', [
  'UnifiedEndpointController.handleRootAgentCard',
  'UnifiedEndpointController.handleRootJsonRpc',
  'UnifiedEndpointController.handleRequest',
  'UnifiedEndpointController.handleSubPathRequest',
  'McpOAuthDiscoveryController.authServerMetadata',
  'McpOAuthDiscoveryController.protectedResourceMetadata',
  'McpOAuthController.getAuthorizationServerMetadata',
  'McpOAuthController.getProtectedResourceMetadata',
  'McpOAuthController.authorize',
  'McpOAuthController.consentInfo',
  'McpOAuthController.authorizePost',
  'McpOAuthController.token',
  'McpOAuthController.register',
  'McpOAuthController.revoke',
  'McpTransportController.handleSse',
  'McpTransportController.sendSseMessage',
  'McpTransportController.handleServerSse',
  'McpTransportController.getTransportStats',
  'McpTransportController.broadcast',
  'McpTransportController.getTransportHealth',
  'McpController.handleMcp',
  'McpController.health',
  'McpController.wellKnown',
  'AgentOpenAICompatController.chatCompletions',
  'AgentOpenAICompatController.listModels',
  'AgentOpenAICompatController.retrieveModel',
  'AgentAnthropicCompatController.messages',
  'ModelPassThroughController.responses',
  'ModelPassThroughController.countTokens',
]);
exclude('Runner daemon channel: called by the runner on its own machine with its runner credential (registration, credential renewal, the work stream), not by a person.', [
  'RunnerController.register',
  'HostedRunnerEnrollmentController.enroll',
  'HostedRunnerEnrollmentController.renew',
  'HostedRunnerEnrollmentController.renewModelToken',
  'WorkerStreamController.post',
  'WorkerStreamController.open',
  'WorkerStreamController.legacyPost',
  'WorkerStreamController.legacyOpen',
  'WorkerStreamController.hostedPost',
  'WorkerStreamController.hostedOpen',
]);
exclude('A live event stream (server-sent events). An MCP tool call returns once; the same state is read with the matching get operation (get_run, check_import_status, runners.get_coding_session) or the run is followed as an MCP task.', [
  'AgentExecutionController.streamAgent',
  'AgentRunsController.streamRun',
  'ApisController.streamImportStatus',
  'RunnerController.codingEvents',
]);
exclude('A binary file transfer (upload or download). An MCP tool call carries JSON; the file\'s metadata is read with files.get, and a build is fetched through channels.get_build_download_link.', [
  'FilesController.upload',
  'FilesController.download',
  'AgentChannelsController.artifact',
]);
exclude('Unauthenticated operational endpoint (health and system-wide metrics for probes and scrapers), not organization data.', [
  'HealthController.check',
  'HealthController.liveness',
  'HealthController.readiness',
  'MonitoringController.getHealth',
  'MonitoringController.getHealthDetails',
  'MonitoringController.getMetrics',
  'MonitoringController.getMetricsHistory',
  'MonitoringController.getPrometheusMetrics',
]);
exclude('One-click link in an email (unsubscribe), authenticated by the token in the link.', [
  'LifecycleController.unsubscribe',
]);

/**
 * Operations whose purpose is a secret: adding, changing or rotating a
 * credential, setting an API's key, an OAuth client secret. No MCP
 * argument carries a secret (secret-arguments.ts), so these are excluded,
 * and calling one by name answers with the app page that takes it
 * (`:param` filled from the call's arguments).
 */
export const SECRET_OPERATIONS: Record<string, { route: string; page: string }> = {
  'credentials.add': { route: 'CredentialsController.create', page: '/credentials/new' },
  'credentials.update': { route: 'CredentialsController.update', page: '/credentials/:id' },
  'credentials.rotate': { route: 'CredentialsController.rotate', page: '/credentials/:id' },
  'credentials.start_oauth': { route: 'OAuth2Controller.authorize', page: '/credentials/new' },
  'credentials.oauth_client_credentials': { route: 'OAuth2Controller.clientCredentials', page: '/credentials/new' },
  'apis.set_key': { route: 'ApisCredentialsController.setKey', page: '/apis/:id' },
  'apis.add_credential': { route: 'ApisCredentialsController.createCredential', page: '/apis/:id' },
  'apis.update_credential': { route: 'ApisCredentialsController.updateCredential', page: '/apis/:id' },
  'channels.set_visitor_sign_in': { route: 'VisitorOAuthConfigController.set', page: '/agents' },
};

/** The exclusion reason of every route in SECRET_OPERATIONS. */
export const TAKES_A_SECRET = 'Takes a secret; add it in the app. No MCP argument carries a secret, so calling it answers with the app page instead.';

exclude(TAKES_A_SECRET, Object.values(SECRET_OPERATIONS).map((s) => s.route));

/**
 * Routes held back until a product decision: each says what the decision
 * is. Empty: every route is a tool, an operation or an exclusion. A route
 * may land here when it waits for someone to decide whether an MCP client
 * may do it at all.
 */
export const HELD_ROUTES: Record<string, string> = {};