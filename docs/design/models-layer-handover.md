# Models layer: what changed, what is proven, what is not

Written for review. It states the design error we made and corrected, the
per-adapter source table as the code actually declares it, which adapters
have ever been run against a real account (none), and the open list with
owners. Review against `docs/design/models-layer.md` as amended on
2026-09-09, not against the original.

## The product this has to serve

Run Claude, Kimi, Qwen and GPT together or separately inside one agent.
Run a custom model that was trained or released on Hugging Face or another
platform. Upload your model to whichever platform you like and connect
almyty to it to run it. almyty does **not** host models and does not run
inference servers: it supports inference through the providers.

Everything below follows from that last sentence.

## The error, stated plainly

The original spec required every deployment adapter to accept
`registrySources: ['s3']` alone, and the conformance suite used S3 as the
only registry. That was wrong in a way that produced real damage rather
than just a bad rule:

- Most managed providers import from a Hugging Face repository, not from
  our object storage, so the rule forced a per-provider workaround.
- One of those workarounds had Fireworks weights streaming through this
  backend. That makes almyty the data path for multi-gigabyte weight
  files, which is the hosting business we are explicitly not in.
- Several adapters were aimed at the wrong product entirely: machines to
  provision rather than the provider's own managed inference offering.

The amended rule, and the general form so it does not return in another
shape: an adapter **declares what its provider can actually read**, native
default first, at least one source, no source mandatory. **Weight bytes
never pass through almyty.** An adapter **refuses** a source its provider
cannot read, with a typed error. Never write an invariant that forces
provider behaviour to match our model: the provider's real API is the
source of truth, verified against current docs with a dated URL.

`docs/design/models-layer.md` line 41 carries the correction inline, so a
future reader sees the old rule and why it is gone rather than a clean
document that invites reintroducing it.

## Naming a model is configuration, not registration

`POST /model-deployments` takes the model as a string. `modelVersionId` is
optional and exists only for operators tracking their own artifacts with
lineage and evaluation history.

The URI grammar has two kinds. **Artifacts** point at bytes and must be
pinned, because the version has to be immutable:

```
hf://org/repo@sha        s3://bucket/prefix@etag
gs://bucket/prefix@gen   file:///abs/path@sha
```

**Provider references** name a model that already exists on a platform.
The platform owns the versioning, so no pin is required:

```
bedrock://   sagemaker://   vertex://   foundry://
azureml://   fireworks://   together://  baseten://
```

Before this change the adapters accepted `bedrock://` and its siblings
while the version API rejected every one of them, so "upload my model to a
platform and connect almyty to it" was not expressible at all.

## Sources do not mix, and the API says so

Bedrock custom import reads S3 and cannot take a Hub repo. Fireworks
imports from a bucket with the customer's own role. Hugging Face Endpoints
serves a Hub repo and nothing else. Vertex wants Cloud Storage or Model
Garden. A provider reference runs only on the provider it names.

That matrix lives in `backend/src/modules/model-deployments/model-source.ts`
and is enforced at submit: `ADAPTER_UNSUPPORTED_SOURCE` with an `accepts`
list, rather than a provider error halfway through a deployment.
`GET /model-adapters` carries `modelSchemes` per adapter so a form can
filter in both directions: the providers that can run the model you have,
or the sources the provider you picked will accept.

## Per-adapter source table

Native default first, as the code declares it. Verified against each
provider's own documentation on 2026-09-09, with dated URLs in
`docs/design/adapters/<key>.md`.

| Adapter | Product it drives | Sources |
|---------|-------------------|---------|
| `aws-bedrock-import` | Bedrock Custom Model Import | `s3` |
| `azure-foundry` | Microsoft Foundry managed compute | `hub` |
| `baseten` | Baseten dedicated deployments | `hub`, `s3`, `gcs` |
| `custom-endpoint` | someone else's OpenAI-compatible server | `hub`, `local` |
| `digitalocean` | Gradient AI Dedicated Inference | `hub` |
| `fireworks` | Fireworks on-demand deployments | `s3` |
| `huggingface-endpoints` | HF Inference Endpoints | `hub` |
| `modal` | Modal Endpoints | `hub` |
| `nebius` | Nebius Token Factory dedicated endpoints | `hub` |
| `ollama` | an Ollama server the customer runs | `hub`, `local` |
| `runpod` | RunPod Serverless vLLM worker | `hub` |
| `sagemaker` | SageMaker AI real-time endpoint | `s3` |
| `stub` | nothing; in-memory, non-production | `hub`, `s3`, `local` |
| `together` | Together dedicated model inference | `hub` |
| `vertex` | Vertex AI endpoints | `gcs`, `hub` |

No adapter provisions a machine. No adapter moves weight bytes. Every one
of the fifteen has a doc file with a dated Verified section.

## What is fixture-only, and what is live-verified

**Every adapter is fixture-only. None has ever been run against a real
account.** The conformance suite has two modes and only the first has
ever executed: fixture mode, which drives the adapter against a recorded
HTTP surface, and `CONFORMANCE_LIVE=<key>` mode, which needs credentials
Frane holds and is never run in CI.

Read nothing below as certified. Fourteen conformance specs pass in
fixture mode, plus `custom-endpoint`'s own spec, plus the gate specs.

Live runs are blocked on provider credentials, not on code.

## The registry is now a minority path

With `hub` as the native default for most providers, a bucket is needed
only where the provider reads object storage itself: `aws-bedrock-import`
and `sagemaker` (S3 only), `fireworks` (S3 only), `baseten` (its delivery
network mirrors from S3 or Cloud Storage), `vertex` (Cloud Storage) and a
self-hosted setup. Nothing else demands one as a precondition, and there
is no install-wide bucket: `ModelRegistryService.connectionFor` resolves a
per-organization `s3_compatible` credential, with environment seeding
restricted to single-tenant installs.

## Deleted, not deprecated

The presigned-archive workaround, the registry mirror path, the
byte-streaming import, the droplet and cloud-init provisioning in the
DigitalOcean adapter, and the Together v1 endpoint path are gone from the
tree. Specs that asserted them were rewritten to assert the refusal
instead, not deleted quietly:
`ollama.conformance.spec.ts` now proves an `s3://` version is refused with
`ADAPTER_UNSUPPORTED_SOURCE`, including when a mirror path is configured.

## Known open, with owners

| Item | State | Owner |
|------|-------|-------|
| Live conformance runs, all 15 adapters | blocked on credentials | Frane supplies keys |
| AWS Bedrock chat dispatch | in progress; it validated at save and had no dispatch case, so a Bedrock provider could never answer | provider agent |
| Perplexity base URL | in progress; legacy Sonar retires 2026-09-27 | provider agent |
| Kimi (Moonshot) and Qwen (DashScope) as first-class providers | in progress | provider agent |
| Cloud catalogs as call targets (Vertex, Foundry serverless, Bedrock) and DigitalOcean Gradient Serverless | in progress | provider agent |
| Models UI rebuilt around model-as-configuration | in progress | UI agent |
| DigitalOcean Dedicated Inference is public preview; Gradient Inference Hub is private preview | gate on availability, expect API drift | open |
