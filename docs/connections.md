# Connections

Connections is where almyty keeps every key, token and account it uses
on your behalf: inference vendors, deployment providers, memory
backends, MCP servers, chat channels, clouds and model registries. You
connect once; agents, models, deployments and the registry use the
connection.

## Connect

Open the catalog (`GET /connectors`) and pick a connector. Each one
offers one or more ways to connect, best first:

- Sign in at the provider (OpenRouter today): you are sent to the
  provider, approve, and come back connected. Nothing to paste. From a
  terminal or a machine without a browser, start with `mode:
  'headless'`; the provider shows a code and you paste it into
  `POST /connections/connect/openrouter/complete`.
- Paste an API key: the form links straight to the page where the key
  is created. The key is checked against the provider before it is
  saved.
- Cloud identity: AWS through a CloudFormation quick-create link that
  makes a role in your account (no long-lived keys), or an access key
  pair; Google Cloud through a service account JSON; Azure through an
  app registration.
- Bucket: an S3-compatible registry takes endpoint, region, bucket and
  access keys and is checked with a HeadBucket.

A connect ends in one of two states. Connected: the provider accepted
the credential and told us what it is (the OpenRouter key label, your
Hugging Face username, the bucket, the AWS role). Failed: the provider
said no; the answer is shown, the connection is kept with a failed
status so you can fix the key at the provider and hit Validate, or
rotate it, without starting over.

## Org or personal

A connection belongs to the organization or to you.

- Organization connections are what agents and deployments use. Making
  one needs the `connections:manage` permission (admins and owners).
- Personal connections are your own keys. Every member can keep them
  when the organization allows it. Free and personal organizations
  allow them by default; paid organizations start with them off, and an
  admin turns them on with `PATCH /organizations/:id { settings: {
  allowUserScopedConnections: true } }`.

Everyone with `connections:read` (every role) sees the organization's
connections; a personal connection is visible to its owner and to
admins.

## What you see

The list and detail views show the connector, the account label, the
health (valid, failed, expired, revoked, quota or unknown), when it was
last checked, the scopes granted and the owner. The secret itself is
never returned, not even masked.

## Validate

`POST /connections/:id/validate` runs the connector's check again:
`GET /models` for most inference vendors, a whoami for Hugging Face and
DigitalOcean, STS for AWS, a HeadBucket for a registry. Health and the
account label are refreshed.

## Rotate

`POST /connections/:id/rotate` replaces the secret in place, so
everything that points at the connection keeps working. For a pasted
key the call returns the form; send it back with the new value. For a
sign-in connector it returns a new authorize URL; completing it swaps
the key on the same connection.

## Disconnect

`DELETE /connections/:id` removes the connection. When the connector
declares a revoke endpoint the key is revoked at the provider first;
otherwise revoke it in the provider's console as well.

## Custom connectors

Admins can add connectors the catalog does not have: any
OpenAI-compatible endpoint, any MCP server, any memory service, any
bucket. `POST /connectors` takes the same shape as a built-in entry: a
key, a kind, the form fields (secret ones marked `x-secret`) and how to
validate.

## Where secrets live

Secrets are stored in one place, the organization's credential store,
encrypted with the platform key or, for organizations that bring their
own KMS, with their key. They leave the backend only inside the request
to the provider they belong to. Every connect, validate, rotate,
disconnect and use is written to the audit log.
