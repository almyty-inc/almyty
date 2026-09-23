/**
 * The platform guide: the jobs people come to almyty to do, each as a
 * short run of steps.
 *
 * Two rules hold for every step, and tests guard both:
 *
 * 1. Done is derived from reality. `key` names a boolean the backend
 *    computes from what exists in the org (see
 *    backend/src/modules/onboarding/onboarding.service.ts); nothing here
 *    is a box someone ticked.
 * 2. The words match the link. `target()` returns where the step's button
 *    goes AND `place`, the page it lands on, which the guide prints next
 *    to the button. The first part of `place` is the sidebar name of the
 *    page `to` opens; __tests__/guide-steps.test.ts fails the build when
 *    they drift, or when `to` is not a route in App.tsx.
 *
 * Links go to the page where the step is done: the create page when there
 * is one (/apis/new, /gateways/new, /apps/new ...), the org's own gateway /
 * agent / app when the step is about that object.
 */
import type { LucideIcon } from 'lucide-react'
import { Bot, Cpu, Globe, Package } from 'lucide-react'

import type { OnboardingState } from '@/lib/api'

export type StepKey = keyof OnboardingState['steps']

export interface StepTarget {
  /** Where the button goes. */
  to: string
  /** The page it lands on, as the sidebar names it: "Gateways › Weather › Integrations". */
  place: string
}

export interface GuideStep {
  /** The backend-derived fact that makes this step done. */
  key: StepKey
  /** What you do, in the imperative. */
  title: string
  /** What happens and when it counts as done. Plain words. */
  description: (state: OnboardingState) => string
  /** Button label. */
  cta: string
  target: (state: OnboardingState) => StepTarget
}

export interface GuideLink {
  title: string
  description: string
  to: string
  place: string
}

export interface Journey {
  id: 'api' | 'agent' | 'ship' | 'runner'
  title: string
  summary: string
  icon: LucideIcon
  steps: GuideStep[]
  /** Optional next moves once the steps are done; links, not tracked steps. */
  more?: (state: OnboardingState) => GuideLink[]
}

export const JOURNEYS: Journey[] = [
  {
    id: 'api',
    title: 'Give an AI your API',
    summary:
      'Turn an API you already have into tools that Claude Code, Cursor or any MCP client can call.',
    icon: Globe,
    steps: [
      {
        key: 'api',
        title: 'Import an API',
        description: () =>
          'Upload, link or paste an OpenAPI, GraphQL, SOAP or Protobuf schema. Every operation becomes a tool.',
        cta: 'Import an API',
        target: () => ({ to: '/apis/new', place: 'APIs › Connect API' }),
      },
      {
        key: 'tools',
        title: 'Check the tools it made',
        description: () =>
          'Each operation is now a tool you can open and test. You can also write one by hand: HTTP, JavaScript, GraphQL or a model call.',
        cta: 'Open tools',
        target: () => ({ to: '/tools', place: 'Tools' }),
      },
      {
        key: 'gateway',
        title: 'Publish tools through a gateway',
        description: () =>
          'A gateway serves the tools you pick at one address, over MCP, A2A, UTCP or Agent Skills. Done once a gateway has at least one tool.',
        cta: 'Create a gateway',
        target: () => ({ to: '/gateways/new', place: 'Gateways › Create gateway' }),
      },
      {
        key: 'external_client',
        title: 'Connect Claude Code, Cursor or another MCP client',
        description: (s) =>
          s.links.gateway
            ? `Run the command for ${s.links.gateway.name} and its tools show up in the client. Done when a call from outside almyty reaches the gateway.`
            : 'Once you have a gateway, its Integrations tab has the command to run. Done when a call from outside almyty reaches it.',
        cta: 'Get the command',
        target: (s) =>
          s.links.gateway
            ? {
                to: `/gateways/${s.links.gateway.id}?tab=integrations`,
                place: `Gateways › ${s.links.gateway.name} › Integrations`,
              }
            : { to: '/gateways', place: 'Gateways' },
      },
    ],
  },
  {
    id: 'agent',
    title: 'Build an agent',
    summary:
      'An agent uses models and your tools to do a job. Use one model or several, from any vendor.',
    icon: Bot,
    steps: [
      {
        key: 'provider',
        title: 'Connect an inference provider',
        description: () =>
          'Add a key for OpenAI, Anthropic, Gemini, Mistral, a local Ollama or another provider. Done once one is active and its last health check did not fail.',
        cta: 'Add a provider',
        target: () => ({
          to: '/llm-providers/new?returnTo=%2Fguide',
          place: 'Inference providers › Add inference provider',
        }),
      },
      {
        key: 'agent',
        title: 'Create an agent',
        description: () =>
          'Lay out a workflow step by step, or give an autonomous agent a goal and the tools to reach it.',
        cta: 'Create an agent',
        target: () => ({ to: '/agents/new', place: 'Agents › New agent' }),
      },
      {
        key: 'agent_run',
        title: 'Run it once',
        description: (s) =>
          s.links.agent
            ? `Open ${s.links.agent.name} and press Run. Done when a run finishes without an error.`
            : 'Open your agent and press Run. Done when a run finishes without an error.',
        cta: 'Open the agent',
        target: (s) =>
          s.links.agent
            ? { to: `/agents/${s.links.agent.id}`, place: `Agents › ${s.links.agent.name}` }
            : { to: '/agents', place: 'Agents' },
      },
    ],
    more: (s) => [
      {
        title: 'Get a second opinion',
        description:
          'On an autonomous agent’s page, Configure verification has other models check its answers. Collaboration, when you edit it, lets other agents or models work alongside it.',
        to: s.links.agent ? `/agents/${s.links.agent.id}` : '/agents',
        place: s.links.agent ? `Agents › ${s.links.agent.name}` : 'Agents',
      },
      {
        title: 'Chat with it',
        description: 'Talk to any agent in the browser before anyone else does.',
        to: '/chat',
        place: 'Chat',
      },
    ],
  },
  {
    id: 'ship',
    title: 'Put it where people are',
    summary:
      'Package an agent as an app and ship it: a hosted web chat, a messaging channel, a terminal command or a desktop app.',
    icon: Package,
    steps: [
      {
        key: 'app',
        title: 'Create an app',
        description: () =>
          'An app puts one or more agents under your name and sets who may use it.',
        cta: 'Create an app',
        target: () => ({ to: '/apps/new', place: 'Apps › Create app' }),
      },
      {
        key: 'distribution',
        title: 'Ship it somewhere',
        description: (s) =>
          `Add a distribution${s.links.app ? ` to ${s.links.app.name}` : ''}: a web chat on its own address, Slack, WhatsApp, Teams and other channels, a terminal command or a desktop app. Done when one is live or built.`,
        cta: 'Add a distribution',
        target: (s) =>
          s.links.app
            ? { to: `/apps/${s.links.app.slug}/distributions/new`, place: `Apps › ${s.links.app.name} › Add a distribution` }
            : { to: '/apps', place: 'Apps' },
      },
    ],
  },
  {
    id: 'runner',
    title: 'Run it on your machines',
    summary:
      'A runner connects a machine you control, a laptop, a server or a CI box, so agents can do work there.',
    icon: Cpu,
    steps: [
      {
        key: 'runner',
        title: 'Connect a runner',
        description: () =>
          'Name it, then run the commands it gives you on the machine. Done when it sends its first heartbeat.',
        cta: 'Start a runner',
        target: () => ({ to: '/runners/new', place: 'Runners › Start a runner' }),
      },
    ],
  },
]

/** The rest of the platform, for when you need it. Links, not steps. */
export const SUPPORTING: GuideLink[] = [
  {
    title: 'Credentials',
    description: 'Keys and accounts your tools use to reach other services, stored encrypted.',
    to: '/credentials',
    place: 'Credentials',
  },
  {
    title: 'Models',
    description: 'Every model your agents can call, where it runs and what it costs.',
    to: '/models',
    place: 'Models',
  },
  {
    title: 'Memory',
    description: 'What your agents remember from one run to the next.',
    to: '/memories',
    place: 'Memory',
  },
  {
    title: 'Approvals',
    description: 'Hold a risky action until a person says yes.',
    to: '/approvals',
    place: 'Approvals',
  },
  {
    title: 'Analytics',
    description: 'Calls, cost and errors across your gateways and agents.',
    to: '/analytics',
    place: 'Analytics',
  },
]

export const ALL_STEPS: GuideStep[] = JOURNEYS.flatMap((j) => j.steps)

export interface JourneyProgress {
  journey: Journey
  done: number
  total: number
  complete: boolean
}

export function journeyProgress(state: OnboardingState): JourneyProgress[] {
  return JOURNEYS.map((journey) => {
    const done = journey.steps.filter((s) => state.steps[s.key]).length
    return { journey, done, total: journey.steps.length, complete: done === journey.steps.length }
  })
}

export function stepsDone(state: OnboardingState): number {
  return ALL_STEPS.filter((s) => state.steps[s.key]).length
}

/**
 * The step to suggest next: the first undone step of the first journey
 * someone has started and not finished, else of the first unfinished
 * journey. Starting to build an agent should not be answered with
 * "import an API" just because that journey is listed first.
 */
export function nextStep(state: OnboardingState): { journey: Journey; step: GuideStep } | null {
  const progress = journeyProgress(state)
  const started = progress.find((p) => p.done > 0 && !p.complete)
  const pick = started ?? progress.find((p) => !p.complete)
  if (!pick) return null
  const step = pick.journey.steps.find((s) => !state.steps[s.key])!
  return { journey: pick.journey, step }
}
