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
    text: 'A gateway serves the tools you pick at one address, so Claude Code, Cursor or another agent can use them. Share tools to make one.',
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
    page: '/connections',
    // Adds to the subtitle rather than repeating it: where keys go, and
    // where AI providers are connected instead.
    text: 'Keys are stored encrypted and never shown again once saved. AI model providers are connected on Models, where their models come with them.',
  },
  models: {
    page: '/models',
    // Adds to the subtitle rather than repeating it: prices, and when a model can be picked.
    text: 'Prices fill in by themselves and stay current. A new model can be picked once a first test call to it has worked.',
  },
  memories: {
    page: '/memories',
    text: 'Entries appear as agents save them. Open one to review it or remove it.',
  },
} as const

export type PageIntroTopic = keyof typeof PAGE_INTROS

export const PAGE_INTRO_TOPICS = Object.keys(PAGE_INTROS) as PageIntroTopic[]
