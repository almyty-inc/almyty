# Modal adapter (`modal`)

Modal **Endpoints**: a managed inference product where Modal builds, runs
and autoscales the serving stack and you name a model. Implementation:
`backend/src/modules/model-deployments/adapters/modal.adapter.ts`.

## Verified (2026-09-09)

**1. Is there a managed inference product?** Yes, and this is new relative
to the earlier pass. "Modal Endpoints let you deploy models from the Modal
Library -- or your own custom weights -- as production-ready inference
APIs." Two flavours: **Shared Endpoints** ("managed inference using
selected Modal Library models, billed per token, Modal-managed capacity")
and **Dedicated Endpoints** ("all Modal Library models plus custom
weights, with configurable autoscaling including scale-to-zero, billed on
compute resources"). Creating one with a model of ours is a Dedicated
Endpoint.
https://modal.com/docs/guide/endpoints
https://modal.com/products/inference

**2. What can be served?** Modal Library models, and custom weights on
top of a library base: "supporting pre-trained open models along with
custom weights from a private Hugging Face repo or Modal Volume". "A
custom model is always served against a base model from the catalog: pass
that base model with `--model` so Modal can pick a compatible recipe, then
point at your weights with the `--custom-hf-*` or `--custom-volume-*`
flags."
https://modal.com/docs/cli/latest/endpoint

**3. Native way to point at a model.** `--model`, "Hugging Face repo ID
for the base model architecture (e.g., 'Qwen/Qwen3.6-27B-FP8')",
[required]. Fine-tuned weights come from `--custom-hf-repo` /
`--custom-hf-revision` / `--custom-hf-token`, or from a Modal Volume the
operator already populated with `--custom-volume-name` /
`--custom-volume-path`. Modal's own guidance for weights is a Volume
("Our recommended method for working with model weights is to store them
in a Modal Volume"), filled either from inside Modal or with `modal volume
put` from the operator's machine -- never from us.
https://modal.com/docs/guide/model-weights

**4. Surface.** There is no public REST control plane for Endpoints; the
documented interfaces are the CLI, the Python SDK and the dashboard. The
adapter drives the CLI.

| Operation | Command |
|-----------|---------|
| create | `modal endpoint create --model <hf repo> [--name ...]` |
| read / list | `modal endpoint list --json [-e <env>]` |
| delete | `modal endpoint stop <identifier> -y [-e <env>]` |
| scale | not exposed; Modal autoscales, including to zero |

`modal endpoint create` flags: `--name`, `--model` [required],
`--routing-region` (default us-west), `--compute-region` (repeatable),
`--colocate-compute`, `--unauthenticated`, `--custom-hf-repo`,
`--custom-hf-revision`, `--custom-hf-token`, `--custom-volume-name`,
`--custom-volume-path`, `-e/--env`. There is no `--gpu` and no
min/max-container flag: capacity is Modal's job.

Example from the docs:

```
modal endpoint create --name my-ft --model Qwen/Qwen3.6-27B-FP8 \
  --custom-volume-name qwen-ft --custom-volume-path /models/qwen
```

The endpoint serves the OpenAI Chat Completions API "under `/v1`", on a
`modal.run` URL that the CLI prints and the dashboard shows. Dedicated
Endpoints "require a proxy token by default": create one with `modal
workspace proxy-tokens create` and call the endpoint with

```bash
curl "<your-endpoint-url>/v1/chat/completions" \
  -H "Authorization: Bearer $MODAL_PROXY_TOKEN_ID.$MODAL_PROXY_TOKEN_SECRET"
```

`--unauthenticated` drops that requirement.
https://modal.com/docs/cli/latest/endpoint
https://modal.com/docs/guide/endpoints

**5. Cost signals.** Modal has a billing API: "APIs in `modal.billing` or
the `modal billing` CLI to generate tabular reports of spend over time
broken down across specific Modal Apps or other resources", with
`modal.Workspace.billing.summary()` and `workspace.billing.report()`
carrying a resource-level breakdown. It is gated to Team and Enterprise
plans and is not per-endpoint, so `costSnapshot` uses the configured rate
and the doc records the API as the later upgrade.
https://modal.com/docs/guide/billing
https://modal.com/docs/reference/cli/billing

## What the adapter does

- `deploy` runs `modal endpoint create` with `--model` from an
  `hf://org/repo` version, `--name` derived from the deployment id, plus
  the custom-weights flags when the operator supplied them. The URL comes
  from the command's own output, falling back to `modal endpoint list
  --json`.
- `readEndpoint` runs `modal endpoint list --json` and matches by name.
  A row whose state reads deployed/running/ready is `ready`; creating or
  starting is `deploying`; stopped is `stopped`; a missing row is
  `missing`. The `--json` key names are not published, so the adapter
  accepts the obvious variants (`name`/`Name`, `state`/`status`/`State`,
  `url`/`endpoint_url`/`Url`) rather than pretending to know one.
- `scale` records intent on the ref only: Modal autoscales a Dedicated
  Endpoint itself and the CLI exposes no replica control. A ceiling of 0
  is reported `stopped` at no cost, which is what an idle Modal endpoint
  actually is.
- `teardown` runs `modal endpoint stop`.

## Deltas from the spec

- **`registrySources` is `['hub']`.** `--model` is a Hugging Face repo id.
  A Modal Volume is a real second source, but filling one is `modal volume
  put` from the operator's own machine; almyty will not stream weights, so
  a volume is only ever referenced, never written. An `s3://` version is
  refused with `ADAPTER_UNSUPPORTED_SOURCE`.
- **No HTTP control plane.** The adapter shells out to `modal`, which must
  be on the API image's PATH. Credentials go in as `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET` in the child process environment, never on the
  command line.
- **`--custom-hf-token` would appear in the process list**, so a private
  fine-tune repo token is passed as `HF_TOKEN` in the child environment
  and the flag is only used when the operator explicitly opts in.
- **Cost is a rate, not a reading**, pending the billing API above.

## Removed in this pass

The previous adapter generated a Python file that built a `modal.App`,
attached a `modal.Secret` holding our registry access keys, downloaded the
whole model from our S3 bucket with boto3 inside the container at cold
start, and launched `vllm.entrypoints.openai.api_server` against `/model`
-- then `modal deploy`ed that file. It was a hand-rolled serving stack on
Modal's raw compute, with almyty as the weight source, written when Modal
Endpoints either did not exist or was not read for. All of it is gone: the
generated app source, the boto3 sync, the registry credentials, the
`modal deploy`/`modal app list`/`modal app stop` app-level commands, and
the guessed `https://<workspace>--<app>-serve.modal.run` URL.

## Live suite

`CONFORMANCE_LIVE=modal` with `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.
Never in CI.
