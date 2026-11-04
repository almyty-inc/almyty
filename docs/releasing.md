# Releasing the @almyty/* packages

The twelve npm packages under `packages/` (client, auth, mcp-mux, the CLIs,
acp-server, runner and the `almyty` umbrella) always share one version. They
are released with [Changesets](https://github.com/changesets/changesets) as a
single `fixed` group, so one release moves all twelve together. The platform's
own `v0.x` tags and Docker images are versioned separately (see the README).

## When you change a package

Add a changeset in the same PR:

```bash
npm ci            # once, at the repository root
npx changeset     # pick the packages you changed, patch/minor/major, one line for the changelog
```

This writes a small file in `.changeset/`. Commit it with your change. A PR
that changes a package without one still merges; it simply doesn't release
anything until someone adds a changeset. `npx changeset status` shows what
the next release would contain.

## What happens next

1. **Version packages PR.** Every push to `development` that has changesets
   waiting updates one open PR called "Version packages"
   (`.github/workflows/version-packages.yml`). It moves all twelve packages to
   the next version, writes each `CHANGELOG.md`, updates every
   `package-lock.json`, and moves `RUNNER_VERSION` in
   `images/runner-env/Dockerfile`. Merging it is the version bump.
2. **Promotion.** The bump travels `development` → `staging` → `master` like
   any other change. On `master`, the runner-env images for the new runner
   version are built from the repository and pushed.
3. **Release.** Tagging `v*` on `master` publishes the packages
   (`.github/workflows/publish-packages.yml`). Every package is built from the
   tagged commit in dependency order: client, auth and mcp-mux first, then
   the CLIs that use the client, then `almyty`. Each one is built against the
   repository's own copy of its dependencies, not the one on npm. Only once
   every build has passed are the packages npm doesn't have yet published,
   dependencies first, with npm provenance. A version already on npm is
   skipped, so re-running a release, or a tag without a version change, is
   harmless.
4. **Post-release PR.** Once npm has the new version and Docker Hub has the
   images, `.github/workflows/post-release.yml` opens a PR against
   `development` that:
   - raises the `@almyty/*` dependency ranges to the released version and
     refreshes each `package-lock.json` from npm;
   - recaptures the six CLI help screenshots from the published packages
     (`scripts/capture-cli-help.js`);
   - pins the runner-env image references to the pushed digests
     (`settings.json`, the backend defaults, the pre-pull DaemonSet).

   Look at the recaptured screenshots, then merge it.

The dependency ranges move after the release, not in the Version packages PR,
on purpose. A lockfile can only point at a version npm already has. If the
ranges moved first, `npm ci` would fail in every package from the moment that
PR merged until the release. The published packages still name the exact
version they were built and tested against: the publish step writes
`^<version>` into each tarball's `package.json`.

## Checklist for whoever cuts the release

The steps above are automatic. A person still has to:

- [ ] Merge the "Version packages" PR when the release should happen. Check
      that its changelog entries read well.
- [ ] Promote to `master` and tag `v*` there, as for any platform release.
- [ ] Check that "Publish npm Packages" passed and lists twelve
      `published` lines (or `already on npm` for a re-run).
- [ ] Look at the post-release PR's screenshots and merge it. If it hasn't
      appeared, run "Post-release" by hand from the Actions tab.
- [ ] If the PR was opened without `RELEASE_PR_TOKEN` (see below), close and
      reopen it so CI runs.

## By hand

- **Publish without a tag.** Run "Publish npm Packages" from the Actions tab
  (`workflow_dispatch`). It publishes the versions already committed: all
  twelve or one package. It never bumps or commits anything, and skips
  anything npm already has. `dist_tag: next` publishes a throwaway
  `<version>-next.<run>` of all twelve under the `next` tag.
- **Try it locally.** `node scripts/release-packages.js order` lists the
  publish order. `node scripts/release-packages.js publish --dry-run` builds
  everything the way the release does and runs `npm publish --dry-run` for
  each package.
- **Recapture one screenshot.** `node scripts/capture-cli-help.js --from npm
  --register --only auth` (needs [freeze](https://github.com/charmbracelet/freeze)).

## Setup this depends on

- npm trusted publishing for each of the twelve packages, bound to this
  repository and the workflow file `publish-packages.yml`. Publishing stays
  in that file, so the binding doesn't change.
- `RELEASE_PR_TOKEN` (optional): a fine-grained token or GitHub App token
  with contents and pull-requests write. With it, the Version packages and
  post-release PRs start CI by themselves. Without it they are opened with
  the default token, which GitHub doesn't let start workflows. That fallback
  needs "Allow GitHub Actions to create and approve pull requests" in the
  repository's Actions settings.
