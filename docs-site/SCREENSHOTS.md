# Screenshot evidence

`public/screenshots/manifest.json` inventories every published screenshot. Its
`baseUrl` is the production documentation URL; `source.environment` separately
records where a browser capture was taken. Use seeded demo data only. Do not
publish secrets, real personal data, internal hostnames, or private repository
details. Review the actual pixels before registering a capture.

Every image has its own capture time and SHA-256. Unknown legacy capture times
are `null`, never a Git commit time or a made-up shared date. `needs-recapture`
explicitly records the outstanding #675 backlog. It does not mean verified.

Keep only images referenced by published documentation, the README or a QA
report. The manifest is an inventory, not a reason to retain an unused image.
When a screenshot is no longer used, remove the image and its manifest entry
together; Git history retains the earlier evidence. Check references across the
repository, not just `docs-site/content`, before removing anything. Only capture
an additional view when a specific guide or report will use it.

## September 23 UI refresh checkpoint

The revised shared headers, navigation and empty states (#737), Models flow
(#739), and sample onboarding (#733) invalidate the earlier browser captures.
Those images are marked `needs-recapture` while the revised UI is awaiting a
staging capture pass. Their observed capture dates, image hashes, source
fingerprints and earlier review notes remain intact; the notes describe that
earlier review, not verification against the new UI. Coordinate the next pass
with the page-based configuration flows and platform guide rollout as well.
Published CLI evidence is separate and is not relabeled by this UI refresh.

The September 24 pass targets the v0.2.8 UI, including page-based creation,
inline configuration, Private visibility and the platform guide. Obsolete
dialog images have been removed from the updated instructions. The September 25
reference audit also removed unused images and their manifest entries.
Source-verified prose changes alone do not mark screenshot evidence current.

Register a reviewed browser capture with its observed capture time:

```sh
node docs-site/scripts/record-screenshot.mjs \
  --image /path/to/capture.png --path screenshots/models.png \
  --title 'Model catalog' --captured-at '2026-09-22T15:00:00Z' \
  --route /models \
  --sources frontend/src/pages/models.tsx \
  --sources frontend/src/components/models \
  --sources frontend/src/components/ui \
  --sources frontend/src/index.css
```

Choose source files/directories covering the depicted page, its child components,
and shared layout/styles. Their content fingerprint detects drift, including
added/deleted files, without depending on checkout timestamps or rewritten Git
history. Tests are excluded. This is a review trigger, not a claim that every
source change changes pixels; inspect the live deployed page and register new
evidence rather than silently refreshing the fingerprint.

CLI captures must come from version-pinned **published** packages. Register them
with `--package @almyty/cli@1.5.0 --command 'almyty --help'` instead of `--route`.
Include that package's `package.json` and command implementation in `--sources`.
Normalize local home paths before rendering and state the normalization in
`--notes`. Do not render help from source and call it a published-binary capture.

An image of a file in this repository, such as the Compose file, is registered
with `--file docker-compose.yml --command 'freeze ...'` and must list that file in
`--sources`, so editing the file marks the image as drifted.

Run `npm run test-screenshots` and `npm run check-screenshots` in `docs-site`.
CI checks complete coverage, missing/broken references, duplicate entries,
image hashes, per-image metadata, and source drift for refreshed images.
`node docs-site/scripts/check-screenshots.mjs --strict` additionally fails while
any image still needs recapture; use it before calling #675 complete.
Keep historical failure evidence explicitly historical rather than replacing
it with an unrelated successful screen.

## September 24 enabled-feature captures

The authorized Business demo fixture now has reviewed captures of Roles, the
inline custom-role and access-policy forms, approval policy list and editor,
compliance policy and report, audit-stream target configuration, and SSO/SCIM
controls. These use separate `*-enabled.png` or form-specific paths; superseded
locked-state images are retained only where a guide still references them.
Each new record has its own observed capture time, image hash and source
fingerprint. No roles, policies, stream targets, IdP configuration or provisioning
tokens were created during this capture pass; visible controls are not evidence
of a completed external integration.

Browser capture initially failed with a WebKit snapshot error. Capturing a new
blank page before navigating to the staging app recovered it without restarting
the shared browser daemon. This is an observed recovery, not a confirmed fix for
the underlying browser failure.

## Enabled-feature evidence still needed

The `*-locked.png` captures record the entitlement gates of an organization
without that entitlement (the local demo stack runs a Business license, so the
Enterprise pages stay locked). They do **not** verify the enabled feature, its
editor, or a successful configuration. The following views still need captures
or end-to-end evidence from an authorized, seeded organization with the
corresponding entitlements:

- Audit export controls and a downloaded evidence file
- Credentials governance controls
- Customer-managed encryption key status and configuration
- Chargeback report
- White-label surface controls

Enterprise-only features still require an authorized fixture. On staging, do not
change billing, mint a license, or bypass a gate to obtain these images; the
local demo stack's throwaway license never leaves the machine. Keep a referenced
locked-state image distinct from evidence of the enabled feature.

The runner list and detail are captured with a runner that is registered but
has never connected, because a connected runner publishes its machine's hostname.
A capture of an online runner still needs a machine whose hostname can be
published.

## Local demo stack captures

The browser captures are taken from a local, seeded stack instead of staging,
so they can be retaken after any UI change without a shared account:

```sh
scripts/demo-seed/stack.sh up            # Postgres, Redis, the commercial API build, vite, fake upstream
node scripts/demo-seed/seed.mjs          # the Northwind AI organization, its agents, channels and runs
node scripts/demo-seed/capture.mjs       # every shot, into /tmp/almyty-demo/shots for review
node scripts/demo-seed/capture.mjs --register name...   # register the reviewed ones
node scripts/demo-seed/guides.mjs        # walk the use-case guides, one shot per step
scripts/demo-seed/stack.sh down
```

The use-case guides under `docs-site/content/examples` are walked through the
UI, step by step as their text says, by `scripts/demo-seed/guides.mjs` on the
same stack, in an organization of their own (Sam Rivera's "Northwind"), so
each guide starts where a new customer starts. It takes one screenshot per
step into `$SHOT_DIR/guides`; a step that cannot be done as written fails the
walk, and the guide text is fixed, not the walk. Register the reviewed shots
with `node scripts/demo-seed/guides.mjs --register`; they are published under
`screenshots/guides/`. Walk the guides once per fresh stack: they create what
they describe, so a second run meets its own leftovers.

`self-hosting-compose.png` is not a browser capture: it renders the top of the
repository `docker-compose.yml`, which is what the self-hosting guide shows.

Nothing leaves the machine: the three model vendors and the Northwind Orders and
Helpdesk APIs are `scripts/demo-seed/fake-upstream.mjs`, the password is a local
test credential, and the Business license is signed by a throwaway key made on
the spot. Registered entries record `source.environment: local-demo`. Addresses
in these captures read `localhost`, which is what the local stack serves; the
product shows the deployment's own API host. Enterprise-only pages (chargeback,
customer-managed keys) stay locked under the Business license, which is what
their `*-locked.png` captures show.
