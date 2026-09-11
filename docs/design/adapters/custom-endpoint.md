# OpenAI-compatible endpoint adapter (`custom-endpoint`)

An inference server somebody else already runs, reached over the
OpenAI-compatible HTTP API: vLLM, TGI, llama.cpp's server, SGLang, a
LiteLLM proxy, a vendor's private endpoint, a colleague's box. almyty
does not create it, scale it or delete it. It watches it, prices it, and
lets the router pick it like any other card. Implementation:
`backend/src/modules/model-deployments/adapters/custom-endpoint.adapter.ts`.

This is the escape hatch that keeps the models layer honest: any surface
that speaks the OpenAI wire format can be used without waiting for a
dedicated adapter.

## Verified (2026-09-09)

**1. The managed product, and whether there is a serverless option.**
There is no product. The customer already stood the server up. The
adapter's whole surface is read-only, and `deploy`, `scale` and
`teardown` throw `UnsupportedOperationError`.

**2. What model sources the product accepts.** Whatever the operator
used when they started the server, which almyty never sees and never
needs. `registrySources` is `['hub', 'local']` only because those are the
two honest answers to "where did those weights come from" for a
self-run server; nothing in the adapter reads a source.

**3. REST surface** (the endpoint's own base URL, the part before
`/chat/completions`; an API key is optional and sent as a bearer token
when set):

| Operation | Method | Path |
|-----------|--------|------|
| health and served models | GET | `/models` |
| chat | POST | `/chat/completions` |

`GET /models` is the OpenAI convention every compatible server
implements, returning `{data: [{id, ...}]}`. It is the only signal the
adapter has, so it carries the whole health check: the endpoint answers
and, when a model id is configured, lists it.
https://platform.openai.com/docs/api-reference/models/list
https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html

**4. Cost signals.** None are discoverable, because there is no billing
API behind a self-run server. Price is declared: `inPerMTok` and
`outPerMTok` for per-token accounting, `hourlyRateCents` for the machine.
Whatever the operator enters is what the router's budget headroom and the
cost reports use.

## What the adapter does

- `readEndpoint` GETs `/models`. Answers and lists the model id, or no
  id is configured: `ready`. Answers but does not list the configured id:
  `missing`, with the served ids in `details.served` so the mismatch is
  visible. 401 or 403: `ADAPTER_AUTH`. 404: `ready` with a note, because
  some servers do not implement `/models`. Anything else: `degraded`
  rather than `failed`, since a self-run box coming back is normal.
- `costSnapshot` echoes the declared rates.
- `deploy`, `scale` and `teardown` refuse.

## Deltas from the spec

- **It is watch-and-price only.** The reconcile loop treats an
  unsupported operation as a permanent property of the adapter, not an
  error to retry.
- **Registration is its own route.** `POST /models/register-endpoint`
  creates the card and the backing provider row, rather than the deploy
  flow. That route writes the key through the credential store like every
  other consumer; nothing is stored inline.
- **`degraded`, not `failed`, on an unreachable host.** The endpoint is
  not ours to fix, and a card that fails hard would drop out of routing
  on a transient blip.

## Live suite

Any OpenAI-compatible server: point `CUSTOM_ENDPOINT_URL` at it and run
`CONFORMANCE_LIVE=custom-endpoint`. The fixture suite covers the four
`readEndpoint` branches without a network.
