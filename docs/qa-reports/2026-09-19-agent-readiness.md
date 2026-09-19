# Agent setup and execution-plan honesty — September 19, 2026

Follow-up to the confusing empty-catalog screenshot in the September 18 report.

## Fix scope

- Workflow activation checks the graph that actually runs (standing strategy,
  orchestrator fallback, or saved graph) and model/role bindings before saving
  ACTIVE. Create/update requests explicitly asking for ACTIVE use the same guard.
- Preflight does not call an LLM or ask the orchestrator to choose a strategy.
  It is a current configuration check, not a guarantee against future provider,
  credential, budget, tool, nested-agent or request-specific failures. Autonomous
  model-selection behavior is unchanged.
- A team-authorized, organization-scoped readiness endpoint drives a visible
  "Not ready to activate" state and configuration actions. Unavailable checks
  are distinct from missing configuration and cannot enable activation.
- Strategy-driven agents display their execution settings, not an unused saved
  builder graph. Orchestrator copy explicitly describes per-request selection
  and fallback; it does not pretend the next request's plan is already known.
- The last-run banner describes only the observed failure. It no longer asserts
  customer/channel impact. Role failures point to Models and the Execution tab.

## Verification

Before implementation, the activation regression failed because activation
resolved successfully despite missing model setup. Two banner tests failed on
the unsupported customer-impact claim and wrong configuration advice.

After implementation: 123 focused backend tests, 30 frontend tests, both
typechecks, EE build and EE dependency-wiring smoke passed. An additional guard
for creating an active strategy before its roles exist is covered separately.
Full CI and post-deployment browser evidence must be checked before claiming
this is fixed on staging. Public documentation base URLs were not changed.

CI repair ownership is separate: PR #646 fixes the previously reported baseline
failures. GitHub run 35428760991 passed backend unit/DB integration, frontend,
typecheck, security scans and required audit jobs. Those results do not stand in
for this branch's CI or live QA.
