# Model registry
Model registry

Status: ACCEPTED (part of the models layer, docs/design/models-layer.md)

The registry is where a version's weights live. It is vendor-neutral by construction: every adapter must be able to deploy from an S3-compatible bucket alone, and the conformance suite exercises no other source.

## Registry URIs

A version points at exactly one of:

| Shape | Meaning |
|---|---|
| `s3://bucket/prefix@etag` | The default. Any S3-compatible store: AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces. |
| `hf://org/repo@sha` | Optional read-only source from the Hugging Face hub. Never required. |
| `file:///abs/path@sha` | Runner-local weights. |

The part after `@` pins the exact bytes. A URI without it is refused, because a version must be immutable.

## Layout

```
<prefix>/
  almyty-manifest.json
  model.safetensors            (or sharded model-00001-of-0000N.safetensors)
  tokenizer files as referenced by the manifest
```

Weights are plain safetensors. Nothing about where the model will run is stored here.

## almyty-manifest.json

```json
{
  "schemaVersion": 1,
  "base": "qwen3-14b",
  "tokenizer": "s3://registry/qwen3-14b@e3b0/tokenizer",
  "chatTemplate": "chatml",
  "license": "Apache-2.0",
  "created": "2026-09-08T09:00:00Z",
  "files": [{ "path": "model.safetensors", "sizeBytes": 29000000000, "sha256": "..." }],
  "quantizations": ["bf16", "awq-int4"],
  "lineage": { "parentVersionId": "..." }
}
```

Required: `schemaVersion` (1), `base`, `tokenizer`, `license`, `created`, `files` (at least one, relative paths only). The manifest's canonical SHA-256 is recorded on the version as `manifestSha`; the sum of `files[].sizeBytes` becomes `sizeBytes`.

## API

`GET /model-versions`, `POST /model-versions { name, registryUri, base?, quantizations?, lineage?, metadata? }`, `GET /model-versions/:id`, `DELETE /model-versions/:id`. CLI: `almyty models versions`, `almyty models register-version --name n --uri <pinned uri> [--base b] [--quantizations q1,q2]`.

Registering an `s3://` version reads and validates `almyty-manifest.json` at the URI and fills base, size, digest and quantizations from it; an unreadable manifest is an error. For `hf://` and `file://` the manifest is optional: when absent, `base` must be given and the version carries `metadata.manifest: null`. A version cannot be deleted while a deployment that is not torn down references it (`VERSION_IN_USE`).

## Configuration

`MODEL_REGISTRY_S3_ENDPOINT`, `MODEL_REGISTRY_S3_REGION`, `MODEL_REGISTRY_S3_ACCESS_KEY`, `MODEL_REGISTRY_S3_SECRET_KEY`, `MODEL_REGISTRY_S3_BUCKET`. Each falls back to the matching `STORAGE_S3_*` value, so one bucket can serve uploads and the registry. `HF_TOKEN` is used only for `hf://` reads of gated repos.

## Rules

- Versions are never deleted by the platform. Deployments come and go; weights stay.
- An adapter receives the registry URI and reads from it with credentials handed to it per call. It never stores them.
- The `hf://` scheme may be absent from a deployment entirely; an adapter that lists only `['s3']` in `registrySources` is complete.
