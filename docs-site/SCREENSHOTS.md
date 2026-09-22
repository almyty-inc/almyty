# Screenshot evidence

`public/screenshots/manifest.json` inventories every published screenshot. Its
`baseUrl` is the production documentation URL; `source.environment` separately
records where a browser capture was taken. Use seeded demo data only. Do not
publish secrets, real personal data, internal hostnames, or private repository
details. Review the actual pixels before registering a capture.

Every image has its own capture time and SHA-256. Unknown legacy capture times
are `null`, never a Git commit time or a made-up shared date. `needs-recapture`
explicitly records the outstanding #675 backlog. It does not mean verified.

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

Run `npm run test-screenshots` and `npm run check-screenshots` in `docs-site`.
CI checks complete coverage, missing/broken references, duplicate entries,
image hashes, per-image metadata, and source drift for refreshed images.
`node docs-site/scripts/check-screenshots.mjs --strict` additionally fails while
any legacy image still needs recapture; use it before calling #675 complete.
Keep historical failure evidence explicitly historical rather than replacing
it with an unrelated successful screen.
