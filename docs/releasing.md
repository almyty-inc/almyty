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
   waiting updates one branch, `changeset-release/development`
   (`.github/workflows/version-packages.yml`). It moves all twelve packages
   to the next version, writes each `CHANGELOG.md`, updates every
   `package-lock.json`, and moves `RUNNER_VERSION` in
   `images/runner-env/Dockerfile`. Whoever runs the release opens the
   "Version packages" PR from that branch (see "Opening the release PRs"
   below). Merging it is the version bump.
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
   images, `.github/workflows/post-release.yml` pushes a branch for a PR
   against `development` that:
   - raises the `@almyty/*` dependency ranges to the released version and
     refreshes each `package-lock.json` from npm;
   - recaptures the six CLI help screenshots from the published packages
     (`scripts/capture-cli-help.js`);
   - pins the runner-env image references to the pushed digests
     (`settings.json`, the backend defaults, the pre-pull DaemonSet).

   Open the PR from the run's summary, look at the recaptured screenshots,
   then merge it.

The dependency ranges move after the release, not in the Version packages PR,
on purpose. A lockfile can only point at a version npm already has. If the
ranges moved first, `npm ci` would fail in every package from the moment that
PR merged until the release. The published packages still name the exact
version they were built and tested against: the publish step writes
`^<version>` into each tarball's `package.json`.

## Checklist for whoever cuts the release

The steps above are automatic. A person still has to:

- [ ] Open the "Version packages" PR from its workflow run's summary (see
      below), and merge it when the release should happen. Check that its
      changelog entries read well.
- [ ] Promote to `master` and tag `v*` there, as for any platform release.
- [ ] Check that "Publish npm Packages" passed and lists twelve
      `published` lines (or `already on npm` for a re-run).
- [ ] Open the post-release PR from the "Post-release" run's summary, look
      at its screenshots and merge it. If the run hasn't happened, start
      "Post-release" by hand from the Actions tab.

## Opening the release PRs

GitHub Actions isn't allowed to open pull requests in this repository, so
whoever runs the release opens the two release PRs. The workflows do the
rest: they build the branch, push it, and try to open the PR. When GitHub
says no, the run still passes, and its summary page shows the branch name
and an "Open the PR" link with the title and a suggested description.

| Workflow         | Branch                          | PR title                                  |
| ---------------- | ------------------------------- | ----------------------------------------- |
| Version packages | `changeset-release/development` | Version packages                          |
| Post-release     | `release/post-<version>`        | Follow up the @almyty/* <version> release |

Open the run in the Actions tab, follow the link, paste the description and
create the PR. A PR opened by a person runs CI like any other. Once it is
open, later runs push to the same branch and update its description, so you
open each one only once. Those later pushes come from GitHub Actions and
don't start CI by themselves: before merging, close and reopen the PR if the
branch changed after you opened it.

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
- No token for the release PRs. GitHub Actions isn't allowed to open pull
  requests in this repository, so the workflows only push the branches and
  link them (see "Opening the release PRs" above).
