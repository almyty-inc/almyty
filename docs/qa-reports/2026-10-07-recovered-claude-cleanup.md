# Recovered Claude cleanup review

The recovered session stopped after saving the four-method access design. This branch completes the credentials/models/sidebar, memory/runner/CLI, and scoped endpoint access work, with current development integrated through a0977514. No merge or deployment is authorized by this report.

## Validation

- Full backend run: 985 passing suites and 14,273 passing tests; three failures in the unchanged dependency-manager suite passed on a rerun with an isolated temporary npm cache (18 tests). Three suites / 20 tests remain gated or skipped.
- Full frontend run: 297 files and 2,475 tests passed. Protected-gateway provisioning additionally passed all 56 controller tests. MCP package: 54 tests passed.
- Backend enterprise build and EE dependency injection smoke passed. Frontend TypeScript, lint and production build passed. Documentation production build and copy check passed.
- The complete local end-to-end journey passed: sign-up, credentials and model provider, API, protected MCP gateway and real key use, UTCP, signed-in Skills, agent and channel chat. MCP conformance passed the existing expected-failures baseline with CI rate limits.
- The first GitHub CI run exposed stale tests and real regressions despite the initial bounded checks. Repairs include API-only agent query columns, A2A scope detection, gateway key-method provisioning and unique sidebar separator keys; full local checks were completed before the next push.
- Browser checks saved a named key with expiry, a username/password, Google company sign-in configuration with a domain restriction, and JWT issuer/JWKS/audience configuration. Actual company-provider authentication was verified with signed mock-provider tests; live vendor accounts were not tested.
- Final development integration: 335 backend regression tests and 19 frontend tests passed. Application captures: 63 refreshed views; all six guide walks completed, 46 steps. Screenshot inventory: 124 tracked, two inherited pending captures, zero errors.

The demo uses isolated PostgreSQL/Redis and fake model/vendor systems. Script-trace and change-set screenshots use explicitly seeded local screenshot fixtures; they do not claim a real model-generated execution. No production or staging data was changed.

## Before and after

Before images below come from development. After images come from the local review branch. The access pair shows the organization scope before changing it to protected external access and configuring the four methods.

| Area | Before | After |
| --- | --- | --- |
| Credentials | ![Credentials before](recovered-claude-cleanup/credentials-before.png) | ![Credentials after](recovered-claude-cleanup/credentials-after.png) |
| Models | ![Models before](recovered-claude-cleanup/models-before.png) | ![Models after](recovered-claude-cleanup/models-after.png) |
| Runner setup | ![Runner before](recovered-claude-cleanup/runner-before.png) | ![Runner after](recovered-claude-cleanup/runner-after.png) |
| Endpoint access | ![Organization scope](recovered-claude-cleanup/access-before.png) | ![Protected methods](recovered-claude-cleanup/access-methods-after.png) |

The blocked worker turns were stopped. Parent-side changes and checks completed the integration; no inaccessible worker approval remains part of this review.

Claude supplied three reviewed code-mode captures. The gateway capture accurately shows code mode disabled by this local server configuration. Development fixes for workflow approval waits and widget conversation continuity are integrated from PR #933; these were previously discovered during his capture.
