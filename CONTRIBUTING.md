# Contributing to almyty

Thanks for taking the time to help. Bug reports, fixes, docs and new features
are all welcome. This page covers how to run almyty on your machine, how to
run the tests, and how a change gets from your branch into a release.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Before you start

- For a bug, open an issue with the steps to reproduce it, unless it is a
  one-line fix you can just send.
- For a new feature or a larger change, open an issue first and describe what
  you want to do. A short conversation up front saves you rewriting a PR.
- Questions about using almyty are best answered by the docs at
  [docs.almyty.com](https://docs.almyty.com).

## Run almyty locally

You need Docker with the Compose v2 plugin, and Node 26 or later for working
outside the containers.

```bash
git clone https://github.com/almyty-inc/almyty.git
cd almyty
docker compose up --build -d
```

That starts PostgreSQL, Redis, the API and the UI:

| Service | Address |
|---|---|
| UI | http://localhost:4001 |
| API | http://localhost:4000 |
| Health check | `curl http://localhost:4000/health` |

The containers mount `backend/` and `frontend/`, so your edits reload without
a rebuild. The defaults are for development only; do not expose this stack
publicly.

### Running the frontend outside Docker

If you prefer to run vite yourself against the API in Docker:

```bash
cd frontend
npm ci
PORT=3002 npm run dev
```

It proxies API calls to `http://localhost:4000`. Set `ALMYTY_API_TARGET` if
your API runs somewhere else.

### Running the backend outside Docker

```bash
docker compose up -d postgres redis
cd backend
cp .env.example .env    # then set DATABASE_PORT=5433 and REDIS_PORT=6380
npm ci
npm run start:dev
```

The backend reads `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USERNAME`,
`DATABASE_PASSWORD` and `DATABASE_NAME`. Compose publishes PostgreSQL on port
5433 and Redis on 6380 on your machine. Every schema change needs a TypeORM
migration; the app never synchronizes the schema on its own.

## Tests

Run the tests for the part you changed before you open a PR. CI runs all of
them again.

```bash
# Backend (Jest)
cd backend && npm ci && npm run test

# Backend, including the database integration tests
# (needs the Compose PostgreSQL and Redis running)
cd backend && npm run test:full

# Frontend (vitest)
cd frontend && npm ci && npm test -- --run

# Frontend end-to-end (Playwright), see frontend/tests/e2e/README.md
cd frontend && npm run test:e2e

# Repository checks: version lockstep, lockfiles, release config and more
npm run check
```

The full backend suite is large. Run it on an otherwise idle machine: several
runs at once compete for workers and can fail in ways that look like code
problems and are not.

Every bug fix and feature comes with tests that would have caught the problem.

### The npm packages

The CLIs and the MCP server live in `packages/`. Each has its own `npm test`.
They are released together at one version; if you change one, add a changeset
in the same PR:

```bash
npm ci        # once, at the repository root
npx changeset
```

See [docs/releasing.md](docs/releasing.md) for how a release goes out.

## Branches and pull requests

`development` is where work lands. `staging` and `master` are promoted from it
and are not targets for contributions.

1. Branch from `development`:

   ```bash
   git fetch origin
   git switch -c fix/login-redirect origin/development
   ```

2. Make your change, with tests.
3. Open the pull request against `development`. Fill in the template: what
   changed, why, and how you tested it. Screenshots help for anything in the UI.
4. Keep the PR focused on one thing. Two unrelated fixes are easier to review
   as two PRs.

A maintainer reviews it, and once CI is green and the review is done it is
merged into `development` and goes out with the next release.

### Commit messages

Keep them short and readable:

- Subject line in the imperative mood, under 72 characters, for example
  `fix login redirect loop on stale cookie`.
- An optional body of one to three short paragraphs explaining why. The diff
  already shows what.
- No emoji, and no generated boilerplate.

## Code conventions

- The product name is written `almyty`, lowercase, in code and text. Capitalize
  it only at the start of a sentence.
- Auth tokens live in httpOnly cookies only. Never write a token to
  `localStorage`; tests enforce this.
- Third-party secrets are stored only as credentials, never in a new column of
  their own.
- In the UI, reuse the components in `frontend/src/components/ui/` rather than
  building a new variant of the same thing.

## Licensing

The core of almyty is Apache-2.0. Code under `backend/ee/` is under a
commercial license. See [LICENSING.md](LICENSING.md). By opening a pull
request you agree that your contribution is licensed under the license of the
files it changes.
