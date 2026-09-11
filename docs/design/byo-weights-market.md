# Who can actually run your own weights

Verified 2026-09-10 against vendor documentation. No live accounts, no keys:
every claim is what a vendor documents or what an unauthenticated probe
implies, and the two are distinguished below.

This exists to settle one question and stop it being reopened: **which
providers let a customer bring a model they trained, or one released on
Hugging Face, and serve it.** That is the product, and it is a different
question from "who has a chat API", which is how the provider list was
being chosen before.

## The tiers

"Bring your own weights" is not binary, and treating it as binary is what
produced an arbitrary provider list.

| Tier | What it means |
|------|---------------|
| 4 | Arbitrary container or code. No architecture list. |
| 3 | Any Hugging Face repo, subject to what the serving engine supports. |
| 2 | Fine-tuned variants of architectures the vendor curates. |
| 1 | A LoRA adapter on a vendor base model, nothing else. |
| 0 | A fixed catalog. Nothing of yours runs here. |

| Provider | Tier | Notes |
|----------|------|-------|
| Replicate | 4 | Cog packages any model into a container; no architecture allowlist. Deployments API with autoscaling. **Not OpenAI-shaped**: a Predictions API. |
| Baseten | 3 and 4 | Any HF repo by config, or a fully custom container via Truss. Managed training that deploys any checkpoint. |
| Modal | 4 | Raw serverless GPU. No catalog and no hosted chat surface of its own; you build the API. |
| HF Inference Endpoints | 3 and 4 | Any Hub repo, public, private or gated, plus arbitrary Docker with the repo mounted read-only. |
| RunPod | 3 and 4 | vLLM worker takes any HF model id; custom images and handlers also supported. |
| Parasail | 3 | Any HF repo including private, with a documented compatibility precheck endpoint. |
| DeepInfra | 3 | A `weights` parameter naming an arbitrary HF repo. No fine-tuning service: you bring an already-trained model. |
| Novita | 3 and 1 | Any HF repo on a dedicated endpoint, plus LoRA adapters that share one running deployment. |
| Together | 2 | Uploads must be fine-tuned variants of an architecture Together already supports; safetensors only. Serverless multi-LoRA discontinued. |
| Fireworks | 2 | Validates the model against a recognised architecture list. Trained LoRAs deploy to dedicated capacity only, never serverless. |
| Nebius Token Factory | 1 and 2 | LoRA adapters served per-token, plus full fine-tuning on a curated base list. No arbitrary repo. |
| Featherless | 3, but console only | Auto-ingests any public HF repo over 100 downloads; private models are a ten-slot feature managed in the web app. **No deployment API at all.** |
| HF Inference Providers | 0 | A router over other providers' catalogs. A competitor to OpenRouter, not a place to put your model. |
| Naver HyperCLOVA X | 0 | Five in-house models. Tuning modifies those bases and is not exportable. |
| Yandex AI Studio | 0 and 2 | Serverless catalog plus dedicated instances from a curated list. |

## What this says about our ten adapters

The set holds up. Fireworks reports over 95% of its tokens coming from
customer-specialized models, which is this product's thesis appearing in
someone else's revenue. Together, Baseten, Modal, RunPod and HF Endpoints
are the other serious managed destinations, and the four hyperscaler paths
exist for customers who cannot leave their own cloud.

The weakest of the ten on this evidence is **Nebius**, which is tier 1:
LoRA adapters and a curated fine-tuning list, no arbitrary repo. That is a
narrower promise than the other nine.

## Real gaps, in order

1. **Replicate.** Tier 4, no architecture allowlist, a Deployments API,
   per-second GPU billing. It was excluded from this platform for having
   "no chat-completions path to ride" — that is, for not being
   OpenAI-shaped. That was the wrong test: we already wrote a bespoke
   dispatch for Perplexity and a path override for Writer. Being awkward
   to integrate is not a reason to skip the best-known place to run an
   open model.
2. **Parasail.** The cleanest adapter target found: a documented REST
   control plane separate from inference, private HF repos via a token,
   pause that genuinely stops billing, and a real billing API with
   per-GPU-hour line items, which almost no vendor offers and which
   `costSnapshot()` needs. Two seams to design for: HF-only sourcing, and
   `scale(0)` must be implemented as pause rather than `replicas: 0`.
3. **DeepInfra** and **Novita**, both of which we already ship as
   call-only cards while both support tier 3 dedicated deployments. We are
   under-using two providers we already support.

## Settled, do not research again

- **Predibase.** Gone. The domain redirects to Rubrik, and the control
  plane hostnames have been withdrawn from DNS entirely. The SDK last
  published 2025-10. Its deployment API was never publicly documented.
- **AI21.** Published a Jamba API sunset of 2026-08-09, now passed.
  `/studio/v1/models` answers 410 Gone and points at a replacement with no
  published API documentation and no resolving host.
- **Featherless.** Genuinely serves your fine-tune, but there is no
  deployment object and no create, scale or teardown API. A provider card
  whose model field takes an arbitrary HF repo id, not an adapter.
- **Naver HyperCLOVA X** and **Yandex.** Tier 0 and captive to Korea and
  Russia respectively. No evidence of adoption outside those markets.
- **iFlytek Spark.** The adapter would be trivial; the blocker is that its
  current and previous generations sit on different bases and share one
  model id, so no default can be correct.
- **Self-hosted Nvidia NIM.** Already served by the generic
  OpenAI-compatible endpoint type. A dedicated provider type would add a
  logo and nothing else.

## The lesson worth keeping

Every vendor above took real effort to verify, and most of that effort
produced a row of facts: a base URL, an auth header, a listing shape, a
pricing source, and a quirk or two. That is data, not code. As long as
adding a vendor means a pull request, this list will always be both
incomplete and arbitrary, and someone will keep asking why it contains
what it contains.
