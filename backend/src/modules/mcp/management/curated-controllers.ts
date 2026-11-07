import { Type } from '@nestjs/common';

/**
 * The controller classes the curated management tools mirror
 * (CURATED_TOOL_ROUTES), loaded on first use.
 *
 * A curated tool authorizes against its REST twin's guards, which needs
 * only the class's metadata, not a registered instance. Naming the class
 * here, rather than finding it among the running application's
 * controllers, keeps that check independent of which modules a given
 * process registers. Required lazily so the MCP module does not pull every
 * controller into its import graph at load time.
 *
 * management-coverage.guard.spec.ts checks that every controller a curated
 * tool names is here and has the handler.
 */
const LOADERS: Record<string, () => Type<any>> = {
  ApisController: () => require('../../apis/apis.controller').ApisController,
  ToolsController: () => require('../../tools/tools.controller').ToolsController,
  GatewaysController: () => require('../../gateways/gateways.controller').GatewaysController,
  GatewayToolsController: () => require('../../gateways/gateway-tools.controller').GatewayToolsController,
  GatewayAuthController: () => require('../../gateways/gateway-auth.controller').GatewayAuthController,
  AgentsController: () => require('../../agents/agents.controller').AgentsController,
  AgentExecutionController: () => require('../../agents/agent-execution.controller').AgentExecutionController,
  AgentRunsController: () => require('../../agents/agent-runs.controller').AgentRunsController,
  LlmProvidersController: () => require('../../llm-providers/llm-providers.controller').LlmProvidersController,
  AgentChannelsController: () => require('../../agent-channels/agent-channels.controller').AgentChannelsController,
  CanonicalMemoryController: () => require('../../memory/canonical/canonical-memory.controller').CanonicalMemoryController,
  ModelCatalogController: () => require('../../model-catalog/model-catalog.controller').ModelCatalogController,
  ModelDeploymentsController: () => require('../../model-deployments/model-deployments.controller').ModelDeploymentsController,
  ModelVersionsController: () => require('../../model-registry/model-versions.controller').ModelVersionsController,
  CredentialsController: () => require('../../credentials/credentials.controller').CredentialsController,
  GrantsController: () => require('../../connections/grants/grants.controller').GrantsController,
  RunnerController: () => require('../../runner/runner.controller').RunnerController,
  WorkspaceController: () => require('../../workspace/workspace.controller').WorkspaceController,
  OrganizationsController: () => require('../../organizations/organizations.controller').OrganizationsController,
  BudgetsController: () => require('../../budgets/budgets.controller').BudgetsController,
  AnalyticsController: () => require('../../monitoring/analytics.controller').AnalyticsController,
  MonitoringController: () => require('../../monitoring/monitoring.controller').MonitoringController,
  RoutingAnalyticsController: () => require('../../model-catalog/routing/routing-analytics.controller').RoutingAnalyticsController,
  ToolHubController: () => require('../../tool-hub/tool-hub.controller').ToolHubController,
  ApprovalsController: () => require('../../approvals/approvals.controller').ApprovalsController,
};

export const CURATED_CONTROLLER_NAMES: readonly string[] = Object.keys(LOADERS);

/** The controller class named `name`, or null when no curated tool mirrors it. */
export function curatedControllerClass(name: string): Type<any> | null {
  const load = LOADERS[name];
  return load ? (load() ?? null) : null;
}
