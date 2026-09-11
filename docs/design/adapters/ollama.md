# Ollama adapter (`ollama`)

An Ollama server, on the developer's own laptop or on a box the customer
rents and runs themselves. This is the one adapter where the machine is
not provider-managed, and it is in the set because "run it locally" is a
real answer for a small model and because it is the cheapest way to try
the whole models layer without an account anywhere. Implementation:
`backend/src/modules/model-deployments/adapters/ollama.adapter.ts`.

almyty never provisions the machine, installs Ollama, or moves weights.
It talks to a server that already exists at a URL the customer gives it.

## Verified (2026-09-09)

**1. The managed product, and whether there is a serverless option.**
Neither, by design. Ollama is a local runtime with an HTTP API, not a
hosted product; there is no account, no billing and no region. Ollama
Cloud exists as a separate hosted offering and is **not** what this
adapter drives; a cloud Ollama endpoint is a call-only card like any
other OpenAI-compatible host.
https://github.com/ollama/ollama/blob/main/docs/api.md

**2. What model sources the product accepts.** Three, all pulled or read
by the server itself:

- **A Hugging Face repository**, addressed as `hf.co/{org}/{repo}[:{quant}]`
  and pulled directly by Ollama. Any GGUF repo on the Hub works this way,
  and the tag suffix selects the quantization.
- **A path on the Ollama host**, via `POST /api/create` with `from` set
  to a GGUF file or a directory of safetensors. The path is on the
  server's own filesystem.
- **A library tag** such as `qwen3:8b`, resolved from Ollama's registry.

https://huggingface.co/docs/hub/ollama
https://github.com/ollama/ollama/blob/main/docs/api.md#create-a-model

**3. REST surface** (the server's own base URL, `http://localhost:11434`
by default; a bearer token is only meaningful when a reverse proxy in
front of it checks one):

| Operation | Method | Path |
|-----------|--------|------|
| pull a model | POST | `/api/pull` |
| create from a path | POST | `/api/create` |
| name a pulled model | POST | `/api/copy` |
| list what is present | GET | `/api/tags` |
| list what is loaded | GET | `/api/ps` |
| load / unload | POST | `/api/generate` with `keep_alive` |
| delete | DELETE | `/api/delete` |
| chat | POST | `/v1/chat/completions` |

Residency in memory is the closest thing Ollama has to a replica count.
`keep_alive: -1` holds a model in VRAM indefinitely, `keep_alive: 0`
unloads it immediately, and `/api/ps` reports what is resident with its
`size_vram` and `expires_at`. The OpenAI-compatible surface is served at
`/v1` on the same host.
https://github.com/ollama/ollama/blob/main/docs/openai.md

**4. Cost signals.** None exist, because Ollama bills nothing. The
machine underneath may not be free, so `providerConfig.hourlyRateCents`
lets an operator account for a rented box; it is charged while the model
is resident and drops to zero when it is unloaded. Per-token price is
always zero.

## What the adapter does

- `deploy` pulls the Hub repo (or creates the model from a host path),
  copies it to the configured tag when one is set, and loads it into
  memory when `replicas > 0`.
- `readEndpoint` reads `/api/tags` for presence and `/api/ps` for
  residency: absent is `missing`, present but not resident is `stopped`,
  resident is `ready`.
- `scale(0)` unloads with `keep_alive: 0`; `scale(n > 0)` reloads with
  the configured `keepAlive`.
- `teardown` deletes the model, tolerating a 404.
- `costSnapshot` reports the configured hourly rate while resident and
  zero otherwise.

## Deltas from the spec

- **`registrySources` is `['hub', 'local']`.** Ollama pulls from the Hub
  itself and reads paths on its own host. It has no object-storage
  client.
- **An `s3://` version is refused** with `ADAPTER_UNSUPPORTED_SOURCE`.
  Mirroring a bucket onto the Ollama host would make almyty the delivery
  route for the weights, which is the thing we do not do. The
  `registryMirrorPath` config that used to do exactly that is gone.
- **Replicas are residency, not instances.** A single server serves one
  copy; `scale(2)` is `scale(1)`.
- **No regions.** The server is wherever the customer put it.
- **Reachability is a first-class failure.** `ECONNREFUSED` and friends
  map to `ADAPTER_UNREACHABLE` rather than a generic error, because a
  laptop that went to sleep is the common case.

## Live suite

`CONFORMANCE_LIVE=ollama` against a real server, with `OLLAMA_BASE_URL`
pointing at it. Pulls `hf://Qwen/Qwen3-0.6B-GGUF@main`, loads it,
unloads it and deletes it. Never in CI: it downloads weights and needs a
machine with the memory to hold them.
