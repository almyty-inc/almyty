# Lifecycle email copy

Source of truth for the marketing copy in the 8 `lifecycle.*` cases of
`email-templates.ts` (each marked `// MARKETING`). Written to `docs-site/STYLE.md`:
lowercase almyty, no em-dashes, no emoji, payoff first, CLI-forward, short.

Cadence (constants in `lifecycle-email.service.ts`): welcome on verify,
state nudge at day 2, showcase at day 5, last touch at day 10. All nudges stop
the instant `first_call` is true. Congrats is the only post-activation send.

Links: `{app}` = https://app.almyty.com, `{docs}` = https://docs.almyty.com.

---

## lifecycle.welcome
**Subject:** welcome to almyty

You're in. almyty turns any API into tools your agents can call, served over MCP, A2A, UTCP, and Agent Skills.

The fastest first win: connect a model, point almyty at an API, and call it from Claude Code, usually a few minutes. From your terminal:

    npm install -g @almyty/cli
    almyty login

**CTA:** Open your dashboard -> {app}

---

## lifecycle.nudge-provider
*(no provider connected yet)*
**Subject:** add a model to almyty

Your account is ready, it just needs a model to think with. Bring your own key from OpenAI, Anthropic, Gemini, or Mistral, or run Ollama locally. No markup either way.

Once a model is connected you can turn an API into tools and put an agent to work.

**CTA:** Add a provider -> {app}/models

---

## lifecycle.nudge-api
*(has a provider, no API/tools yet)*
**Subject:** turn an API into tools

You've connected a model. Next, point almyty at an API and every operation becomes a typed tool your agents can call. OpenAPI, GraphQL, SOAP, Protobuf, or an npm package, no code required.

No API handy? Load the Petstore sample and watch it generate tools.

**CTA:** Import an API -> {app}/apis

---

## lifecycle.nudge-gateway
*(has tools, no gateway yet)*
**Subject:** publish your tools as a gateway

You have tools. Publish a gateway and they are reachable over MCP, A2A, UTCP, and Agent Skills from one endpoint, ready to plug into Claude Code or any MCP client.

**CTA:** Create a gateway -> {app}/gateways

---

## lifecycle.nudge-first-call
*(has a gateway, no successful call yet: the payoff)*
**Subject:** call your API from Claude Code

Your gateway is live. Point your assistant at it and your API runs inside it. In Claude Code:

    claude mcp add mygateway --transport http \
      https://api.almyty.com/your-org/your-gateway

Ask Claude to do something and it calls your API directly. That is the whole loop.

**CTA:** Open your gateway -> {app}/gateways

---

## lifecycle.example-showcase
*(day 5, still not activated)*
**Subject:** see almyty do something real

Here is a concrete one: give Claude Code your own API. Import a schema, publish an MCP gateway, and call it from Claude in about five minutes.

Stuck on a step? Reply to this email. A human reads it.

**CTA:** Read the walkthrough -> {docs}/examples/give-claude-your-api

---

## lifecycle.last-touch
*(day 10, still not activated: final nudge, then stop)*
**Subject:** what people build with almyty

A few things teams ship on almyty:

- a support agent that drafts replies and has a second model check them before they send
- a governed refund agent with approvals and a full audit trail
- one planner driving Claude Code, Codex, and aider on the same repo

All built on the same path: APIs to tools, tools to gateways, agents on top.

This is the last nudge from us. Your account stays, so you can pick it up whenever you want.

**CTA:** Browse examples -> {docs}/examples

---

## lifecycle.activated-congrats
*(fires once, after the first successful call)*
**Subject:** your API is live in almyty

Nice. Your first call went through, so almyty is doing real work now.

Where people go next:

- add a second model from another vendor to verify answers before they ship
- give your agent memory so it recalls context across runs
- connect a machine with a runner so agents can run tools on your own hardware

**CTA:** Explore what is next -> {docs}
