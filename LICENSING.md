# almyty Licensing

almyty is **open core**. Two licenses coexist in this repository:

| Scope | License | File |
|-------|---------|------|
| Everything **outside** `backend/ee/` (the OSS core) | **Apache License 2.0** | [`LICENSE`](./LICENSE) |
| Everything **inside** `backend/ee/` (Enterprise Edition) | **Commercial / proprietary** | [`backend/ee/LICENSE`](./backend/ee/LICENSE) |

The core is genuinely open: agents, tools (every type), gateways, all protocols
(MCP / A2A / UTCP / Skills), BYOK, single-org RBAC, memory, the runner, basic
audit, and spend governance are Apache-2.0 and never gated. That surface *is* the
product and the adoption funnel. The Enterprise Edition gates only what
enterprises need and individual self-hosters never miss.

## Why not gate on `organization.plan`?

`organization.plan` is a mutable free-text column (`free` / `pro` / `enterprise`).
Once the source is public, anyone can set it to `enterprise`, so it is **not** a
security boundary. It remains purely display/billing metadata. **No EE feature is
allowed to key off `plan`.** Enforcement instead runs through a signed license.

## Runtime enforcement: the licensing module

`backend/src/modules/licensing/` is the single source of truth for entitlements.

- **License token** — an Ed25519-signed, offline-verifiable token decoding to
  `{ entitlements: string[], limits: Record<string, number>, expiresAt }`.
  Format: `v1.<base64url(payload)>.<base64url(signature)>`. It is verified with a
  public key only, so air-gapped deployments validate without calling home.
- **`LicenseService`** — resolves the active feature set. `has(feature)` and
  `limit(key)` are the API. With no token (the OSS default) it returns the
  **community** entitlement set; a tampered or expired token is rejected and also
  falls back to community. A valid token unions its EE entitlements onto the
  community baseline.
- **Public key** — built-in default (`DEFAULT_LICENSE_PUBLIC_KEY`), overridable
  via `ALMYTY_LICENSE_PUBLIC_KEY`. The token is supplied via `ALMYTY_LICENSE_KEY`
  (or `ALMYTY_LICENSE_TOKEN`). The matching **private** signing key is held
  offline by the vendor and is not in this repo. A dev keypair for local testing
  lives in `backend/scripts/license/`.

### Backend gating

```ts
@RequiresEntitlement('sso')   // decorator, modeled on @Roles(...)
@UseGuards(JwtAuthGuard, EntitlementGuard)
```

`EntitlementGuard` returns **402 Payment Required** (feature exists but is not
licensed) when the active license lacks the entitlement, letting the frontend
distinguish "upgrade to unlock" from "access denied" (403).

Read the active entitlements at `GET /licensing/entitlements`:

```json
{ "edition": "community", "entitlements": ["agents", "..."], "limits": {}, "expiresAt": null }
```

### Frontend gating

`frontend/src/hooks/useEntitlement.ts` fetches `/licensing/entitlements` and
exposes `has(feature)` / `limit(key)` / `edition`. The `<EntitlementGate>`
component hides or locks EE-only UI. These are UX affordances only — the backend
guard is the real boundary.

## Build model: OSS vs EE

The two builds differ only by whether `backend/ee/` is compiled in.

- **OSS build (default, what public CI tests):** the backend `tsconfig.build.json`
  includes only `backend/src/**`, so `backend/ee/` is never compiled. An OSS-only
  source build is fully functional and self-contained: `loadEeModules()` returns
  an empty list, `LicenseService` returns the community set.
- **EE build:** overlays the core with `backend/ee/` using
  [`backend/tsconfig.ee.json`](./backend/tsconfig.ee.json) (`npm run build:ee`,
  output in `dist-ee/`), and registers the EE modules in the
  application module. The `LicensingModule` is `@Global`, so EE modules inject
  `LicenseService` / `EntitlementGuard` without extra wiring.

The **official `almyty/api` Docker image ships the EE build** (the GitLab-style
one-image open-core model): the EE modules are present in the image but every
EE route is entitlement-gated at runtime and returns 402 without a valid license
token. Building from source with `npm run build` produces the pure-OSS artifact. The EE feature modules live in `backend/ee/modules/` and are
loaded at runtime through `backend/src/ee-loader.ts`, which returns an empty list
when the `ee/` tree is absent — the OSS build compiles and runs without it. A
minimal reference stub shows the exact
shape a real EE module takes (an entitlement-gated controller). Because it lives
under `backend/ee/`, it does not affect the OSS build or tests.

## Minting a license (vendor / dev)

The dev keypair in `backend/scripts/license/` can mint local tokens:

```bash
node backend/scripts/license/mint-license.js --entitlements sso,advanced_rbac --expires 2027-01-01
```

Set the printed token as `ALMYTY_LICENSE_KEY` to activate those entitlements.
