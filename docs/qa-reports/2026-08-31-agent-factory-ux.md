# Agent factory UX restage QA — 2026-08-31

Follow-up to `2026-08-31-agent-factory.md` after #530/#532 replaced the ReactFlow canvas with a header + Tabs + Cards + Dialogs detail page. Driven with VibeSurfer against `app.staging.almyty.com` as `qa.apps.ui.20260831@almyty.com` (org Almyty Apps QA UI 20260831, app `Customer Care Console`). Staging frontend was rolled to the already-pushed `almyty/frontend:staging` image from the in-progress #532 image build; the matching API image had not finished building, so Slack publish hit the API that was already on the cluster.

## Result

| Area | Result | Evidence |
|---|---|---|
| Apps list | Pass | One product card, "Anyone with the link", New app. |
| App detail | Pass | Header + slug + Ship somewhere. Tabs Distributions (3) / Agents (1) / Settings. No canvas. |
| Distribution cards | Pass | ProtocolBadge per medium (SLACK / TERMINAL / WEB). Status Badge Live (success) or Not shipped yet (outline). No emoji. |
| Edit dialog | Pass | Clicking a card opens a centered Dialog, not a drawer. |
| P1 Slack credentials | Pass | Dialog has Bot token + Signing secret. Save credentials, then Publish → card and dialog both show Live, button flips to Take it down. |
| Settings tab | Pass | Branding, who can use it, cost ceiling per run, requests per user/IP. |
| Empty state | Pass | Fresh app shows EmptyState icon + "Not shipping anywhere yet" + Ship somewhere, plus the refusals banner (needs agent, cost cap, rate limits). |
| Terminal build | Correct refusal | "This deployment cannot build tui because bun is not installed on the build host." Build stays available to pick a platform; the host cannot compile. |
| Hosted-chat hostname | Still blocked | Not re-tested; wildcard still routes `*.almyty.app` to dashboard sign-in. |
| Agent Activate (P2) | Still open | Agent-detail actions-menu, out of /apps scope. |

## Findings this pass

### Closed — P1 channel credentials

The Slack dialog now has Platform credentials (Bot token, Signing secret). Saving dummy values and publishing made the distribution Live. The previous silent fail is gone.

### P2 — operator copy still says `tui`

The Terminal dialog refusal reads `cannot build tui` rather than "Terminal app". The list/cards use labels; this one sentence still prints the raw target.

### P2 — Slack dialog said Ready to ship with empty credential fields

Before anything was typed, the Slack dialog showed a green Ready to ship. The stored configuration had no credentials. The check is not reflecting missing required credentials in the form. Publishing after filling them worked; the pre-fill status was wrong.

### Note — #532 API image still building

Frontend was rolled manually from the already-pushed tag so this pass could run. The staging-api pods were still the 09:42 image. Slack publish succeeded against that API once the new frontend sent credentials. When the #532 API image lands, a second frontend+API restart is expected.

## Screenshots

Dropped into `docs-site/public/screenshots/`:

| File | Shows |
|---|---|
| `apps-list.png` | Apps list |
| `apps-canvas.png` / `apps-detail.png` | Detail page, Distributions tab, Slack+Web Live |
| `apps-empty.png` | Fresh app empty state |
| `apps-agents.png` | Agents tab |
| `apps-settings.png` | Settings tab with cost cap + rate limits |
| `apps-slack-credentials.png` | Slack dialog credential fields |
| `apps-slack-live.png` | Slack published, Take it down |
| `apps-build-capabilities.png` | Terminal bun refusal |

`docs/agent-factory.md` canvas paragraph replaced with the detail-page description.
