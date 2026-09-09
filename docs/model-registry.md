# Model registry

Status: ACCEPTED (part of the models layer, docs/design/models-layer.md)

The registry is optional. almyty supports inference through the providers, so a deployment normally points at whatever its provider natively reads, most often a Hugging Face repository, and the weights never touch us.

The registry exists for the providers that read object storage themselves: Bedrock and SageMaker load model artifacts from S3 by design, Fireworks imports from a bucket with your own role, Baseten mirrors from S3 or Cloud Storage through its delivery network, Vertex reads Cloud Storage, and a self-host points its own server at its own store. An earlier version of this document required every adapter to deploy from S3 alone. That was wrong, and it forced a workaround per provider; each adapter now declares the sources its provider can really read, native default first.

## Registry URIs

A version points at exactly one of two kinds of thing.

**An artifact**, which is bytes a provider will read. The part after `@` pins them, and a URI without it is refused, because a version must be immutable.

| Shape | Meaning |
|---|---|
| `hf://org/repo@sha` | A Hugging Face repository. The native source for most providers and the common case. |
| `s3://bucket/prefix@etag` | Any S3-compatible store: AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces. Native for the AWS adapters and Fireworks. |
| `gs://bucket/prefix@generation` | Google Cloud Storage. Native for Vertex. |
| `file:///abs/path@sha` | A path on the machine that serves the model. |

**A provider reference**, which names a model that already exists on a platform. The platform versions it, so no pin is required and there is no manifest to read: `bedrock://`, `sagemaker://`, `vertex://`, `foundry://`, `azureml://`, `fireworks://`, `together://`, `baseten://`.

Registering a version at all is optional. A deployment takes the same reference inline as `model`, and the version entity exists for people who want lineage, a manifest digest and evaluation history attached to their own artifact.

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

`GET /model-versions`, `POST /model-versions { name, registryUri, base?, quantizations?, lineage?, metadata? }`, `GET /model-versions/:id`, `DELETE /model-versions/:id`. CLI: `almyty models versions`, `almyty models register-version --name n --uri <uri> [--base b] [--quantizations q1,q2]`.

Registering an `s3://` version reads and validates `almyty-manifest.json` at the URI and fills base, size, digest and quantizations from it; an unreadable manifest is an error, because our own registry is the one place that must carry one. For `gs://`, `hf://`, `file://` and provider references the manifest is a bonus: when absent, `base` must be given and the version carries `metadata.manifest: null`. A version cannot be deleted while a deployment that is not torn down references it (`VERSION_IN_USE`).

## Connection

The registry is the organization's own bucket. Every read and write resolves through the organization's registry connection: a credential of type `s3_compatible` with `endpoint` (for non-AWS S3), `region`, `bucket`, optional `prefix`, `accessKeyId` and `secretAccessKey`, encrypted like every other credential. `ModelRegistryService.connectionFor(organizationId)` is the single seam; adapters get the same keys through `ModelDeploymentsService.credentialsFor()` as `registryAccessKeyId`, `registrySecretAccessKey`, `registryEndpoint`, `registryRegion`, `registryBucket` whenever the version lives at an `s3://` URI.

An organization without a connection cannot register an `s3://` version or deploy one: the API answers `REGISTRY_NOT_CONNECTED` and the UI opens the connect sheet. There is no shared bucket and no silent fallback. Nothing else needs a bucket, so an organization that only runs models from the hub, from a provider it already uses, or through a registered endpoint never meets this.

`MODEL_REGISTRY_S3_*` (falling back to `STORAGE_S3_*`) has one job: on first boot of a single-tenant self-host, when exactly one organization exists and it has no registry connection, they seed that organization's connection. With two or more organizations they are ignored and a warning is logged.

## Rules

- Versions are never deleted by the platform. Deployments come and go; weights stay.
- An adapter receives the registry URI and reads from it with credentials handed to it per call. It never stores them.
- An adapter that lists no `s3` in `registrySources` is complete and normal: it means the provider reads its weights somewhere else, which is the common case.
- Weight files never pass through almyty. An adapter that cannot read a version's source refuses the deploy and names what it does accept.
