import { IsBoolean, IsIn, IsOptional } from 'class-validator';
/**
 * Shape of the onboarding state returned by
 * GET /organizations/:organizationId/onboarding.
 *
 * Every step is computed server-side from real entity state so that a
 * user who does everything through the CLI still sees the guide complete
 * itself in the web UI (spec acceptance criterion #2). Nothing here is a
 * "user ticked the box" flag.
 */
export interface OnboardingSteps {
  /** >=1 active LLM provider the health sweep last saw healthy. */
  provider: boolean;
  /** >=1 API imported for the org. */
  api: boolean;
  /** >=1 tool in the org that is not deleted (generated or hand-written). */
  tools: boolean;
  /** >=1 non-system gateway with >=1 tool assigned. */
  gateway: boolean;
  /** >=1 successful gateway request OR agent run. */
  first_call: boolean;
  /**
   * >=1 gateway request whose client is not the almyty frontend
   * (a real MCP handshake, OpenAI-compat call, or curl).
   */
  external_client: boolean;
  /** >=1 agent the org built (sub-agent scratch copies excluded). */
  agent: boolean;
  /** >=1 such agent has finished a run successfully (workflow or autonomous). */
  agent_run: boolean;
  /** >=1 app (the product an agent ships as). */
  app: boolean;
  /** >=1 app distribution that is live (served) or built (artifact produced). */
  distribution: boolean;
  /** The requesting user's runner has sent at least one heartbeat. */
  runner: boolean;
}

/**
 * The org's own objects the guide deep-links into, so a step can land on
 * the place it is done ("connect a client" opens *your* gateway's
 * integrations). Each is the oldest matching row, or null.
 */
export interface OnboardingLinks {
  /** A non-system gateway with tools, MCP preferred. */
  gateway: { id: string; name: string; type: string; endpoint: string } | null;
  /** The oldest agent the org built. */
  agent: { id: string; name: string } | null;
  /** The oldest app. */
  app: { slug: string; name: string } | null;
}

/**
 * The pages that carry a one-line "what this is, what to do first" intro.
 * Mirrored by PAGE_INTROS in frontend/src/components/onboarding/page-intros.ts;
 * a dismissal names one of these and nothing else.
 */
export const PAGE_INTRO_TOPICS = [
  'apis',
  'tools',
  'gateways',
  'agents',
  'apps',
  'runners',
  'credentials',
  'models',
  'memories',
] as const;

export type PageIntroTopic = (typeof PAGE_INTRO_TOPICS)[number];

export interface OnboardingState {
  steps: OnboardingSteps;
  /** Where each step's link lands for this org, when the thing exists. */
  links: OnboardingLinks;
  /** Per-user dismissal of the dashboard card. */
  dismissed: boolean;
  /** Per-user: the page intros this user closed. */
  dismissedIntros: PageIntroTopic[];
  /** Earliest successful call through a gateway the org set up itself, ISO string. */
  activatedRealAt: string | null;
}

/**
 * The global ValidationPipe runs with `forbidNonWhitelisted: true`, and a
 * property with no class-validator decorator is not whitelisted. Without
 * these, PATCH .../onboarding answered 400 "property dismissed should not
 * exist" for the one field it exists to accept, so reopening the getting
 * started card failed every time.
 */
export class PatchOnboardingDto {
  @IsOptional()
  @IsBoolean()
  dismissed?: boolean;

  /** Close one page's intro line for this user. */
  @IsOptional()
  @IsIn(PAGE_INTRO_TOPICS as unknown as string[])
  dismissIntro?: PageIntroTopic;

  /** Bring every page intro back for this user. */
  @IsOptional()
  @IsBoolean()
  resetIntros?: boolean;
}

