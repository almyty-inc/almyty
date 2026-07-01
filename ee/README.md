# almyty Enterprise Edition (`ee/`)

This directory holds **commercial, closed-source** almyty features. Everything
outside `ee/` is open source under **Apache-2.0**; everything inside `ee/` is
proprietary and governed by [`ee/LICENSE`](./LICENSE). This is the standard
open-core split used by infra projects like GitLab and Sentry.

See [`/LICENSING.md`](../LICENSING.md) for the full boundary and build model.

## The boundary in one sentence

> The community (OSS) build ships and runs **without** `ee/`; the enterprise
> build composes the OSS core **plus** `ee/`, and each EE feature only activates
> when the runtime `LicenseService` confirms a valid, signed entitlement.

## Two independent gates

An EE feature is only live when **both** hold:

1. **Code gate (build-time):** the `ee/` module is compiled into the running
   image. The OSS build excludes this directory entirely.
2. **Entitlement gate (run-time):** a valid Ed25519-signed license token grants
   the feature's entitlement. Enforced by `@RequiresEntitlement(...)` +
   `EntitlementGuard` on the backend and `useEntitlement(...)` on the frontend.
   See `backend/src/modules/licensing/`.

The runtime gate matters most: it is what makes the paywall enforceable once the
source is public. EE gating **never** keys off the mutable `organization.plan`
string.

## Layout

```
ee/
├── LICENSE                 # commercial license notice (proprietary)
├── README.md               # this file
└── example-ee/             # placeholder EE module — reference stub
    ├── example-ee.module.ts
    └── example-ee.controller.ts
```

`example-ee/` is a minimal, illustrative stub that demonstrates how a real EE
module gates itself behind an entitlement. Real EE features (SSO/SAML, advanced
RBAC, audit export/SIEM, compliance pack, chargeback, BYO-KMS, approval policy —
see `docs/plans/monetization-byok-open-core.md` WS3.3) land here.

## Building

- **OSS build (default):** the backend `tsconfig` includes only `backend/src`,
  so `ee/` is not compiled — the community image is fully functional without it.
- **EE build:** overlays `ee/` onto the core via `ee/tsconfig.json` (extends the
  backend config) and registers `ExampleEeModule` (and future EE modules) in the
  app. This repo intentionally keeps the two builds simple to avoid CI risk; the
  EE assembly is documented in `/LICENSING.md` rather than wired into public CI.
