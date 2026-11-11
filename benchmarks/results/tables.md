### Tool definitions in context before the first turn (o200k_base tokens)

| API | operations | tools | (a) plain MCP tools/list | (b1) skill-first proxy, all 13 tools | (b2) proxy, its 2 gateway tools only | (b3) code-mode gateway (search_tools, get_tool, run_code) | (a) / (b3) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Open-Meteo forecast | 1 | 1 | 519 | 1,387 | 251 | 612 | 0.8x |
| GitHub REST, issues tag | 66 | 66 | 22,413 | 1,387 | 251 | 612 | 36.6x |
| Stripe API (full) | 612 | 612 | 409,045 | 1,387 | 251 | 612 | 668.4x |

### One fixed task: tokens in context at the final call, and input summed over turns

| API | task | plain MCP: final / summed (turns) | code mode: final / summed (turns) | proxy, no skill: final / summed (turns) | proxy + skill prompt: final / summed (turns) |
|---|---|---|---|---|---|
| Open-Meteo forecast | Current temperature in Berlin | 554 / 519 (1) | 2,102 / 3,363 (3) | 1,501 / 2,842 (2) | 2,161 / 4,957 (3) |
| GitHub REST, issues tag | Read issue #1 of octocat/Hello-World | 22,439 / 22,413 (1) | 5,498 / 13,388 (4) | 4,237 / 7,087 (3) | 33,418 / 40,468 (4) |
| Stripe API (full) | Look up customer cus_bench0001 | 409,064 / 409,045 (1) | 1,593 / 3,459 (3) | 2,539 / 5,389 (3) | 262,555 / 267,914 (4) |

### Discovery: did the search find the task's tool?

| API | target tool | code mode search_tools (query: rank in top 10) | proxy almyty_search (keyword: in the 20 shown) | get_tool result | skill prompt |
|---|---|---|---|---:|---:|
| Open-Meteo forecast | `open_meteo_get_v1_forecast` | "weather forecast": 1 | "weather forecast": found | 1,343 | 660 |
| GitHub REST, issues tag | `github_issues_get` | "get an issue": not found; "read issue": 5 | "get an issue": not found; "issue": not found | 874 | 29,181 |
| Stripe API (full) | `stripe_get_customers_customer` | "retrieve a customer": 1 | "retrieve a customer": not found; "customer": not found | 267 | 260,016 |

### Import to usable tools (wall clock, local stack)

| API | description size | runs | min | median | max | tools generated |
|---|---:|---:|---:|---:|---:|---:|
| Open-Meteo forecast | 134 KiB | 5 | 0.17 s | 0.22 s | 0.22 s | 1 |
| GitHub REST, issues tag | 317 KiB | 5 | 0.34 s | 0.42 s | 0.49 s | 66 |
| Stripe API (full) | 8,123 KiB | 5 | 3.16 s | 3.66 s | 3.77 s | 612 |
