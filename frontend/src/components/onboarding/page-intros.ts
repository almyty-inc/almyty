/**
 * The one-line intro at the top of each main page: what the page is, and
 * what to do first. Plain words, no internal names.
 *
 * The topic list mirrors PAGE_INTRO_TOPICS in
 * backend/src/modules/onboarding/dto/onboarding.dto.ts, which is what a
 * dismissal is validated against; __tests__/page-intros.test.ts keeps the
 * two in step and checks every page renders its own intro.
 */
export const PAGE_INTROS = {
  apis: {
    page: '/apis',
    text: 'An API here is a schema you imported: every operation in it becomes a tool. Start by importing one, from a file, a link or pasted text.',
  },
  tools: {
    page: '/tools',
    text: 'Tools are what agents and AI clients call. Most come from an imported API; you can also write one by hand. Open one and test it before you publish it.',
  },
  gateways: {
    page: '/gateways',
    text: 'A gateway serves the tools you pick at one address, so Claude Code, Cursor or another agent can use them. Create one, then choose its tools.',
  },
  agents: {
    page: '/agents',
    text: 'An agent uses models and tools to do a job. Build a workflow when you know the steps, or an autonomous agent when you would rather give it a goal.',
  },
  apps: {
    page: '/apps',
    text: 'An app is how people reach your agents: a hosted web chat, a messaging channel, a terminal command or a desktop app. Create one, then add where it ships.',
  },
  runners: {
    page: '/runners',
    text: 'A runner connects a machine you control so agents can do work on it. Set one up; it shows here once it checks in.',
  },
  credentials: {
    page: '/credentials',
    text: 'Keys and passwords your tools use to reach other services, stored encrypted. Add one here, then pick it when you set up a tool or an API.',
  },
  models: {
    page: '/models',
    text: 'Every model your agents can call and what it costs. Connect a provider once and all of its models show up here and in every model chooser.',
  },
  memories: {
    page: '/memories',
    text: 'What your agents remember from one run to the next. Entries appear as agents save them, and you can review or remove them here.',
  },
} as const

export type PageIntroTopic = keyof typeof PAGE_INTROS

export const PAGE_INTRO_TOPICS = Object.keys(PAGE_INTROS) as PageIntroTopic[]
