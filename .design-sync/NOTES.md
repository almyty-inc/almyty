# design-sync notes — almyty frontend DS

Repo-specific gotchas for future syncs. Read this before re-running.

## Source shape & build
- Shape: **package**, **synth-entry** mode. `almyty-frontend` is an *application*, not a
  component library — `vite build` emits an app bundle, not a library entry with per-component
  exports/`.d.ts`. So there is no dist entry; the converter synthesizes one from `src/`.
- **PKG_DIR self-symlink**: the converter resolves `PKG_DIR = <node_modules>/<pkg>`, which for an
  app doesn't exist. We bridge it: `ln -sfn .. frontend/node_modules/almyty-frontend` so
  `PKG_DIR` resolves to `frontend/`. The symlink is under `node_modules/` (gitignored) — recreate
  it on a fresh clone before building. Do **not** pass `--entry` (a `--entry` is taken as *the*
  single bundle entry → would bundle one file; omitting it triggers synth-from-all-src).
- Build command: just `node .ds-sync/package-build.mjs --config .design-sync/config.json
  --node-modules frontend/node_modules --out ./ds-bundle` (no `--entry`).
- Discovery yields **116 components** from 34 `ui/` files (compound parts expand: Card→CardHeader/…,
  Dialog→DialogContent/…). Sub-parts ship functional + typed; rich previews go on the ~34
  top-level components and compose the sub-parts inside.

## Styling / tokens / fonts
- Tailwind **v4** (`@import "tailwindcss"` + `@config`). `cfg.cssEntry` →
  `dist/assets/index-To_jvoug.css` (the app's compiled CSS: tokens `:root`/`.dark` HSL vars +
  utilities + dark mode). **Re-sync risk**: that filename is content-hashed and changes on every
  `vite build`. If `[CSS_PLACEHOLDER]`/missing-css fires after a frontend rebuild, update
  `cfg.cssEntry` to the new `dist/assets/index-*.css` (largest one). Consider compiling a stable
  stylesheet via the Tailwind CLI if this churns.
- Fonts: Manrope / DM Sans / JetBrains Mono load via a remote Google Fonts `@import` in
  `src/index.css` → `[FONT_REMOTE]`, served at runtime, nothing to ship. Not a `[FONT_MISSING]`.

## Render/capture engine: Playwright (vibesurfer fork ABANDONED)
- Capture/render runs on **Playwright 1.59.1** (pins chromium build **1217**, cached at
  `~/Library/Caches/ms-playwright/` from this repo's E2E setup, installed in `.ds-sync`). Zero
  download. This is the default the staged scripts already use — nothing to re-apply.
- A vibesurfer (`vs`) capture fork was attempted (`.design-sync/pw-vibesurfer-shim.mjs`, a
  Playwright-compatible shim over the `vs` CLI) and **abandoned**: on `vs 0.1.14`, `vs capture`
  reliably timed out (10s) on static, fully-loaded local pages under sequential automation (0/8).
  Filed as a bug: `_internal/vs-capture-bug-report.md`.
  **UPDATE 2026-06-24: that bug is fixed in `vs 0.1.15`** — re-tested 32/32 captures across 4
  sequential rounds, valid PNGs, `--full-page` working. So the upstream blocker that abandoned the
  shim is GONE. Playwright 1.59.1 remains the working default (don't change it for this sync), but
  the `vs` capture path is now a viable alternative if anyone wants to revisit the shim — the shim
  itself was never re-validated end-to-end past the capture timeout, so treat it as unproven, not
  broken.
- The shim debugging did surface one real, non-obvious gotcha worth keeping if anyone revisits it:
  any subprocess driver of an out-of-process browser MUST call it **async** — a synchronous
  `execFileSync` blocks the converter's event loop, starving the in-process HTTP server it serves
  the bundle from, so navigations fail with "Could not connect to the server."

## Upload
- Target project: `3c21c63e-72a4-4e0e-a641-b22aecdeb275` ("almyty Design System"). Non-empty +
  no sync anchor → **atomic** path. User chose **converge** (keep the prior hand-built files;
  deletes empty) — do NOT reconcile-delete its `frontend/`, `preview/`, `uploads/`, `HANDOFF.md`,
  etc. unless the user opts into cleanup.

## Re-sync risks
- `cfg.cssEntry` hashed filename (above) — top churn source.
- PKG_DIR self-symlink + the playwright→shim import swap must both be re-applied on a fresh clone /
  each run (documented above).
- Group is `general` for all 116 (flat synth dir). Improve later via doc frontmatter `category`.

## Known render warns
- (to be filled after the full render check is triaged)
