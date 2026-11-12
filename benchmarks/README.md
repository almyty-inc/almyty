# Benchmarks

Two measurements, against a local almyty stack built from this checkout:

1. **Tokens.** How many tokens a model reads when an API's generated tools
   reach it (a) as a plain MCP gateway's `tools/list`, (b) through
   `@almyty/mcp-server` in its default skill-first mode, and (c) through a
   code-mode gateway (`search_tools`, `get_tool`, `run_code`). Both for the
   definitions alone and for one fixed task per API.
2. **Import time.** Wall clock from uploading an API description to the
   import job reporting the tools generated.

The latest numbers and what they do not show are in [results.md](results.md);
the raw output is [results/results.json](results/results.json).

## Rerun

```bash
# once: dependencies, and the MCP proxy the benchmark launches
(cd backend && npm ci)
(cd packages/mcp-server && npm ci && npm run build)

benchmarks/stack.sh up      # Postgres + Redis in docker, backend built and run as in production
npm run bench               # from the repo root: installs benchmarks/ deps, runs, writes results/
benchmarks/stack.sh down

npm run bench:test          # the harness's own tests (token counting, subsetting, accounting)
```

`node benchmarks/run.mjs --runs 5 --only github-issues,stripe --api http://localhost:4310`
takes the options separately. Set `ANTHROPIC_API_KEY` to add Anthropic's own
count (`/v1/messages/count_tokens`, model from `ANTHROPIC_COUNT_MODEL`) of
each initial tool list next to the tiktoken one; without it only tiktoken is
used, and `results.json` says so.

`stack.sh` uses ports 4310 (API), 5440 (Postgres) and 6390 (Redis) and its
own container names, so it runs beside `docker-compose` and
`scripts/dev-stack.sh`. Two settings differ from a default install:
`CODE_MODE_GATEWAYS=true` (code exposure is off by default) and
`RATE_LIMIT_MAX=100000` (the harness polls the import job every 100 ms).

## The API descriptions

Pinned in [specs.json](specs.json) by commit URL and SHA-256; downloaded into
`benchmarks/.cache/` and checked on every run.

| id | source | imported |
|---|---|---|
| `open-meteo` | open-meteo/open-meteo `openapi/forecast.yml` | as is (1 operation) |
| `github-issues` | github/rest-api-description `api.github.com.json` | the operations tagged `issues` (66), with the components they reach; the cut is deterministic and its SHA-256 is pinned too |
| `stripe` | stripe/openapi `openapi/spec3.json` | as is (612 operations) |

## Method

**Import.** For each description: one fresh account (sign-up is limited to 10
an hour), then N runs (default 5) of `POST /apis/import` as a multipart upload
with `generateTools=true`, the same call the web app's "Connect an API" makes,
polling `GET /apis/:id/import-status/:jobId` every 100 ms until `completed`.
The time is from sending the upload to seeing `completed`, so it includes
the upload, parsing, operation and schema rows, tool generation and writing,
and up to 100 ms of polling slack. Between runs the API is deleted (its
operations and tools go with it by foreign-key cascade), so every run imports
into an empty organization. The backend runs compiled (`node dist/main`,
`NODE_ENV=production`), not in watch mode with query logging.

**Tokens.** After the last run, the generated tools are put on two MCP
gateways, one with the default exposure and one with `exposure: code`. Then:

- *(a) plain MCP*: every page of the tools gateway's `tools/list`.
- *(b) skill-first proxy*: `packages/mcp-server/dist/index.js <org>/<gateway>`
  started over stdio, initialized as an MCP 2025-06-18 client, and its
  `tools/list` read. It always registers 13 tools: `almyty_execute`,
  `almyty_search` and 11 management tools (`almyty_create_api`, ...). Both the
  13 and the 2 gateway tools alone are reported.
- *(c) code mode*: the code gateway's `tools/list` (`search_tools`,
  `get_tool`, `run_code`).

A tool list is counted as the compact JSON of
`[{name, description, input_schema}]`, the part a client hands to a model.
Titles, annotations, icons and output schemas are left out. Counting uses
tiktoken's `o200k_base` encoding (js-tiktoken, bundled ranks, no network).

**The task.** Each description has one fixed read task (`specs.json`): the
weather in Berlin, issue #1 of `octocat/Hello-World`, Stripe customer
`cus_bench0001`. Each path is played against the live stack, every call
really made, and every call and result counted:

- plain MCP: the model calls the tool directly (1 turn).
- code mode: `search_tools` with each listed query until the target tool is
  in the results, `get_tool` for it, then `run_code` with
  `return await <namespace>.<function>(<arguments>)` built from `get_tool`'s
  answer.
- proxy: `almyty_search` with each listed keyword until the target is among
  the tools it shows, then `almyty_execute`. Counted twice: without a skill,
  and with the gateway's skill prompt added to the context (MCP prompts are
  picked by the person, not called by the model, so it is counted as context
  with no model call before it).

Reported per path: the context at the final call (tool definitions + every
earlier call and result), and the input summed over turns (what an API with
no prompt caching bills, since each turn resends the conversation). The final
result, the API's answer, is the same on every path and is left out. When a
search never surfaces the target, the run continues with the right name
anyway and the discovery table says so: a model would have searched more.

## Files

- `run.mjs` the benchmark; `stack.sh` the local stack
- `lib/tokens.mjs` counting and turn accounting; `lib/subset.mjs` the OpenAPI tag cut
- `lib/specs.mjs` pinned download + checksums; `lib/almyty.mjs` REST and MCP calls
- `lib/mcp-stdio.mjs` a minimal stdio MCP client; `lib/report.mjs` the tables
- `lib/anthropic-count.mjs` the optional Anthropic count
- `test/` tests for the counting, accounting, subsetting and tables
