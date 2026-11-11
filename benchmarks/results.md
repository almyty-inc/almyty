# Results, 2026-11-11

Measured by `run.mjs` (method in [README.md](README.md)) at commit
`d35bc888` on an Apple M2 Pro (10 cores, 32 GiB, macOS, Node 24.14.1,
Docker 29.9.2). Tokens are tiktoken `o200k_base`; Anthropic's count was not
run (no API key in the environment). Raw data: [results/results.json](results/results.json).

## Tool definitions in context before the first turn

| API | tools | (a) plain MCP `tools/list` | (b) skill-first proxy, as served (13 tools) | proxy, `almyty_execute` + `almyty_search` only | (c) code mode (3 meta-tools) |
|---|---:|---:|---:|---:|---:|
| Open-Meteo forecast | 1 | 519 | 1,387 | 251 | 612 |
| GitHub REST, `issues` tag | 66 | 22,413 | 1,387 | 251 | 612 |
| Stripe (full) | 612 | 409,045 | 1,387 | 251 | 612 |

Per tool, a generated definition averaged 519 (Open-Meteo), 340 (GitHub) and
668 (Stripe) tokens. The proxy and code-mode figures do not depend on the API.

## One fixed task (search, get, call)

Context at the final call / input summed over all turns (turns):

| API | plain MCP | code mode | proxy, no skill | proxy + skill prompt |
|---|---|---|---|---|
| Open-Meteo: weather in Berlin | 554 / 519 (1) | 2,102 / 3,363 (3) | 1,501 / 2,842 (2) | 2,161 / 4,957 (3) |
| GitHub: read issue #1 | 22,439 / 22,413 (1) | 5,498 / 13,388 (4) | 4,237 / 7,087 (3) | 33,418 / 40,468 (4) |
| Stripe: look up a customer | 409,064 / 409,045 (1) | 1,593 / 3,459 (3) | 2,539 / 5,389 (3) | 262,555 / 267,914 (4) |

Discovery, the part those numbers depend on:

| API | code mode `search_tools` (rank of the right tool) | proxy `almyty_search` | `get_tool` answer | skill prompt |
|---|---|---|---:|---:|
| Open-Meteo | "weather forecast": 1 | "weather forecast": found | 1,343 | 660 |
| GitHub | "get an issue": not in top 10; "read issue": 5 | "get an issue": no match; "issue": 66 matches, right one not among the 20 shown | 874 | 29,181 |
| Stripe | "retrieve a customer": 1 | "retrieve a customer": no match; "customer": right one not among the 20 shown | 267 | 260,016 |

Every call was made against the live stack. Open-Meteo and GitHub answered
with real data on all three paths; Stripe answered 401 (no key), which is the
same on every path and does not change the counts.

## Import to usable tools

Wall clock from upload to the import job reporting tools generated, 5 runs each:

| API | description | operations | tools | min | median | max |
|---|---:|---:|---:|---:|---:|---:|
| Open-Meteo forecast | 134 KiB YAML | 1 | 1 | 0.17 s | 0.22 s | 0.22 s |
| GitHub REST, `issues` tag | 317 KiB JSON | 66 | 66 | 0.34 s | 0.42 s | 0.49 s |
| Stripe (full) | 8.1 MiB JSON | 612 | 612 | 3.16 s | 3.66 s | 3.77 s |

The machine was busy with other work during the run (load average 36 to 52
on 10 cores); an earlier run under similar load gave a Stripe median of 5.0 s.
Treat these as "seconds, not minutes" rather than as exact figures.

## What the numbers show

- A plain MCP gateway's definitions grow with the API: about 0.5k tokens for a
  one-operation API, 22k for 66 operations, 409k for Stripe, which is past the
  context window of a 200k-token model before the first message.
- Code mode puts 612 tokens of definitions in context whatever the API's
  size, and the fixed task cost 1.6k to 5.5k tokens of context. Against
  plain MCP that is 4x less for the GitHub subset and about 250x less for
  Stripe. For a one-tool API it costs more than plain MCP (2.1k against 0.55k).
- The old "about 300 tokens" line for the skill-first proxy matches only its
  two gateway tools (251). As served it registers 13 tools, 1,387 tokens,
  because the 11 management tools are always there.
- Import time: a 612-operation description became 612 callable tools in
  about 3 to 5 seconds of backend time; the small ones in under half a second.

## What they do not show

- **Other tokenizers.** Only `o200k_base`. Claude, Gemini and Llama
  tokenizers give different counts, and providers add their own tool-use
  system prompt (a fixed cost on every path, left out here).
- **Model behaviour.** No model ran. The search queries, the scripts and the
  arguments are scripted in `specs.json`; a model may search more often, pick
  other words, or get the arguments wrong. The proxy gives the model tool
  names and one-line descriptions but no parameter schema unless a skill
  prompt is in context, so "proxy, no skill" assumes the model guesses the
  arguments right. The discovery table shows the scripted searches sometimes
  miss: search quality, not only token count, decides the real cost.
- **Search was lexical.** No embedding provider was configured, so
  `search_tools` ranked without embeddings. Its order also varied a little
  between runs (GitHub's code-mode total moved by 300 tokens).
- **Caching.** "Summed over turns" assumes no prompt caching. With caching,
  repeated definitions are billed at a discount and the multi-turn paths cost
  relatively less than shown.
- **The skill prompt** is the gateway's whole skill, one per gateway; for
  Stripe it is 260k tokens, so "proxy + skill prompt" is not a usable path
  for an API that size. Per-tool skills were not measured.
- **Responses.** The API's answer is left out on every path. In code mode a
  script can filter a large answer before the model sees it; that saving is
  not measured here.
- **Import time** is backend processing on one laptop with Postgres and
  Redis in local containers, measured through the HTTP API with 100 ms
  polling. It excludes finding and downloading the description, setting up
  credentials, creating a gateway, connecting a client and any human time.
  A cluster deployment, a cold backend, or a much larger description were not
  measured.
- **Three APIs, one task each.** Not a sample of APIs or tasks; the GitHub
  description is a 66-operation subset, not the full 1,280-operation API.

## Side findings

- `almyty_execute` (proxy) returns an upstream failure as a normal result:
  Stripe's 401 came back with `isError` unset, where the plain gateway and
  `run_code` both flagged it.
- `almyty_search` matches the query as one substring of name or
  description, so a natural phrase ("get an issue") matches nothing.
- GitHub's issue tools carry the long operation description ("The API returns
  a 301 Moved Permanently status if ..."), which makes `search_tools` results
  for that API about 1.8k tokens each.
