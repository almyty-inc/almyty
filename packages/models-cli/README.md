# @almyty/models

The almyty model catalog from your terminal: which models exist, which the
router may pick and **why not** when it may not, what a routing policy would
choose right now, what everything costs, and where self-hosted weights run.

```sh
npx @almyty/auth login
npx @almyty/models list
```

## What makes a model usable

Support in almyty is registry data, never a code list. You connect a provider
once and every model it lists shows up. A model is usable when its **card**
exists in your organization's catalog and:

1. something can call it — a stored LLM provider row, or an endpoint URL from
   a hosted model,
2. its status is `active`, and
3. it is checked: its provider's key check has passed (one real call with the
   key covers every model that provider lists), or, for an endpoint with no
   provider row, a real short call through that model has.

A model the provider stops listing goes `inactive`; one the vendor answers
"model not found" for is marked unavailable. `list` and `get` report which of
those applies, so a card that will not be picked says so instead of looking
like any other row:

```
Llama 3 8B  [llama-3-8b]  private_cloud/eu-central  $0.1/$0.2 per M (feed:litellm)
    9c2f…  not selectable: waiting for its provider's key check (check the provider on the Models page)
```

## Commands

Every read command takes `--json` and writes undecorated JSON to stdout.

### Catalog

| Command | What it does |
|---|---|
| `list [--selectable] [--status s] [--tier t] [--provider id]` | Model cards, each line saying selectable or why not |
| `get <id>` | One card in full: what can call it, capabilities, pricing, the last check, measured latency |
| `register --name <n> --provider <providerId> --model <vendorModelId> [--tier t] [--region r] [--context n]` | Register a card against a stored LLM provider. A server you run (vLLM, TGI, llama.cpp) is added as a `custom` LLM provider first, then registered against like any other |
| `set <id> [--name n] [--tier t] [--region r] [--context n] [--status s] [--price-in n --price-out n] [--clear-price]` | Change a card; a price pair is an override that wins over the automatic feed |
| `sync [providerId]` | Import what a provider lists; selectable at once when the provider's key check has passed. With no id, every active provider |
| `validate <id>` | One real short call through one model. A provider's key check already covers its models; this is for an endpoint with no provider row |
| `delete <id>` | Remove a card |

Cards arrive on their own: connecting a provider, changing it, every passing
key check and a sweep every six hours import what that provider currently
lists. `sync` is the same import by hand.

### Routing

`route` is the honest answer to "why did it not pick that model". It takes the
same policy an `llm_call` node carries, and **calls nothing** — it plans.

```sh
npx @almyty/models route --objective cheapest --tier private_cloud \
  --regions eu-central --needs tools --budget-headroom 500
```

```
2 candidate(s), in the order they would be tried:
  1. Llama 3 8B  [llama-3-8b]  openai  private_cloud/eu-central  $0.1 per M blended
     9c2f…  cheapest at $0.10 blended
  2. Mixtral  [mixtral-8x7b]  openai  private_cloud/eu-central  $0.24 per M blended
     4a71…  next cheapest

Rejected 3:
  1d0e…  no callable provider
  7bb2…  privacy tier public exceeds the ceiling private_cloud
  e551…  not usable yet
```

| Flag | Meaning |
|---|---|
| `--objective cheapest\|fastest\|pinned` | `cheapest` by blended feed price, `fastest` by measured p50 |
| `--tier local\|private_cloud\|public` | Privacy ceiling; anything above it is rejected |
| `--regions <a,b>` | Allowed regions |
| `--needs tools,vision,reasoning` | Capabilities that must be true |
| `--capabilities '<json>'` | The full capability object, when `--needs` is not enough |
| `--pinned <id>` | One card or vendor model id, by name |
| `--chain <a,b>` | An explicit fallback order |
| `--budget-headroom <cents>` | Reject anything that would not fit |
| `--prefer <providerId or type,...>` | Providers to prefer, best first, applied before cost |

It exits 5 when no card satisfies the policy, so a check can be a check.

### Versions, adapters, hosting

Registering a version is optional: do it when you want lineage, a manifest
digest and evaluation history attached to your own artifact. Skip it to just
run a model that already lives somewhere.

| Command | What it does |
|---|---|
| `versions` | Registered model versions |
| `register-version --name <n> --uri <pinned uri> [--base b] [--quantizations q1,q2]` | `hf://org/repo@sha`, `s3://bucket/key@etag`, `gs://bucket/key@gen`, `file:///path@sha` |
| `adapters` | Every adapter: what it can run (`modelSchemes`), its capabilities, which config fields are secret |
| `host <model> --adapter <key> [...]` | Run a model on a provider's managed product |
| `hosted` | Hosted models: desired vs actual, state, spend |
| `hosted <id>` | One hosted model in full, including its endpoint and rate |
| `scale <id> <replicas>` | Set desired replicas; `0` scales to zero |
| `teardown <id>` | Tear the endpoint down; weights stay in the registry |

`deploy`, `deployments` and `deployment <id>` also work, as other names for
`host`, `hosted` and `hosted <id>`.

Naming the model is configuration, so it is the positional argument:

```sh
npx @almyty/models host hf://Qwen/Qwen3-0.6B@main --adapter huggingface-endpoints
npx @almyty/models host fireworks://accounts/acme/models/qwen3-tuned --adapter fireworks
npx @almyty/models host --model-version <id> --adapter modal --desired '{"replicas":1}'
```

An **artifact** reference points at bytes and is pinned, so the hosted model is
reproducible. A **provider reference** (`bedrock://`, `vertex://`,
`fireworks://`, …) names a model that already exists on a platform, which
versions it itself. The two do not mix freely: `adapters` lists what each
provider can really read, and a mismatch is refused at submit with
`ADAPTER_UNSUPPORTED_SOURCE` rather than as a provider error later.

## Secrets never travel on argv

`ps` shows every process's arguments to every user on the machine, shell
history keeps them, and most CI runners echo them. So this tool does not take
a secret as a flag value.

**Adapter configuration.** Best is not to paste one at all: connect the
provider account once and name the connection.

```sh
npx @almyty/connections connect huggingface
npx @almyty/models host hf://Qwen/Qwen3-0.6B@main \
  --adapter huggingface-endpoints --credential <connectionId>
```

Otherwise pass the object from a file or stdin:

```sh
npx @almyty/models host hf://Qwen/Qwen3-0.6B@main --adapter huggingface-endpoints --config-file hf.json
cat hf.json | npx @almyty/models host hf://Qwen/Qwen3-0.6B@main --adapter huggingface-endpoints --config-stdin
```

`--config` still works for the fields an adapter does **not** mark secret, and
is refused the moment it carries one that is. `adapters` prints which fields
those are.

## Pricing

Automatic. A daily job loads the LiteLLM cost map and cross-checks OpenRouter;
a disagreement above 25% is kept on the card and `get` prints it. `pricingSource`
says where a number came from: `feed:litellm`, `feed:openrouter`, `native`,
`adapter`, `manual` (an override you set with `set --price-in/--price-out`), or
`unpriced`.

## Environment

| Variable | Meaning |
|---|---|
| `ALMYTY_TOKEN` | Token override; skips `~/.almyty/credentials.json` |
| `ALMYTY_URL` | API URL override |
| `NO_COLOR` | Honoured: this tool never colours its output |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error (bad flags, missing argument, unknown command) |
| 3 | not authenticated — run `npx @almyty/auth login` |
| 4 | not found |
| 5 | the operation ran and failed (a check that did not pass, a policy that resolves to nothing) |

The same table in every `@almyty/*` CLI.

## About almyty

almyty is the platform for AI agents, agnostic by design: any LLM, any API
turned into tools, served over MCP, A2A, UTCP and Agent Skills.

- Website: https://almyty.com
- Design notes: `docs/models.md` in the almyty repository
- Source: https://github.com/almyty-inc/almyty

Run `npx @almyty/models --help` for the full surface.

Apache-2.0 © Almyty Inc.
