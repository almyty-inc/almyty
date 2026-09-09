# Model registry

Status: ACCEPTED (part of the models layer, docs/design/models-layer.md)

The registry is optional. almyty supports inference through the providers, so a deployment normally points at whatever its provider natively reads, most often a Hugging Face repository, and the weights never touch us.

The registry exists for the two cases where object storage is the native path: the AWS adapters, where Bedrock and SageMaker load model artifacts from S3 by design, and a self-host pointing its own server at its own store. An earlier version of this document required every adapter to deploy from S3 alone. That was wrong, and it forced a workaround per provider; each adapter now declares the sources its provider can really read, native default first.

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

## Connection

The registry is the organization's own bucket. Every read and write resolves through the organization's registry connection: a credential of type `s3_compatible` with `endpoint` (for non-AWS S3), `region`, `bucket`, optional `prefix`, `accessKeyId` and `secretAccessKey`, encrypted like every other credential. `ModelRegistryService.connectionFor(organizationId)` is the single seam; adapters get the same keys through `ModelDeploymentsService.credentialsFor()` as `registryAccessKeyId`, `registrySecretAccessKey`, `registryEndpoint`, `registryRegion`, `registryBucket` whenever the version lives at an `s3://` URI.

An organization without a connection cannot register an `s3://` version or deploy one: the API answers `REGISTRY_NOT_CONNECTED` and the UI opens the connect sheet. There is no shared bucket and no silent fallback.

`MODEL_REGISTRY_S3_*` (falling back to `STORAGE_S3_*`) has one job: on first boot of a single-tenant self-host, when exactly one organization exists and it has no registry connection, they seed that organization's connection. With two or more organizations they are ignored and a warning is logged.

## Rules

- Versions are never deleted by the platform. Deployments come and go; weights stay.
- An adapter receives the registry URI and reads from it with credentials handed to it per call. It never stores them.
- An adapter that lists no `s3` in `registrySources` is complete and normal: it means the provider reads its weights somewhere else, which is the common case.
- Weight files never pass through almyty. An adapter that cannot read a version's source refuses the deploy and names what it does accept.
