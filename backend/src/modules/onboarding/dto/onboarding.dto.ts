/**
 * Shape of the onboarding checklist state returned by
 * GET /organizations/:organizationId/onboarding.
 *
 * Every step is computed server-side from real entity state so that a
 * user who does everything through the CLI still sees the checklist
 * complete itself in the web UI (spec acceptance criterion #2).
 */
export interface OnboardingSteps {
  /** >=1 LLM provider whose status is not 'error'. */
  provider: boolean;
  /** >=1 API imported for the org. */
  api: boolean;
  /** >=1 non-system gateway with >=1 tool assigned. */
  gateway: boolean;
  /** >=1 successful gateway request OR agent run. */
  first_call: boolean;
  /**
   * >=1 gateway request whose client is not the almyty frontend
   * (a real MCP handshake, OpenAI-compat call, or curl). Optional,
   * shown after first_call.
   */
  external_client: boolean;
}

export interface OnboardingState {
  steps: OnboardingSteps;
  /** True once the Petstore sample workspace has been seeded. */
  sampleWorkspace: boolean;
  /** Per-user dismissal of the dashboard card. */
  dismissed: boolean;
  /** Earliest successful call of any kind (sample or real), ISO string. */
  activatedSampleAt: string | null;
  /** Earliest successful call involving a non-sample entity, ISO string. */
  activatedRealAt: string | null;
}

export class PatchOnboardingDto {
  dismissed?: boolean;
}

export interface SampleWorkspaceResult {
  apiId: string;
  toolIds: string[];
  gatewayId: string;
  agentId: string | null;
  /** True when this call actually seeded; false when it was already present. */
  created: boolean;
}
