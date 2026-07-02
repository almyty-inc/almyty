# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via **GitHub Security Advisories** ("Report a vulnerability" on this repository). Do not open public issues for security reports.

We aim to acknowledge reports within **72 hours** and to provide a fix or mitigation plan within **90 days** of triage, prioritized by severity. We will credit reporters in the release notes unless you ask otherwise.

**In scope:** the backend API, frontend, CLIs (`@almyty/*` packages), the runner daemon, channel adapters, and the official Docker images.

**Out of scope:** vulnerabilities in third-party LLM providers or messaging platforms themselves, and issues requiring a compromised host.

## Supported versions

Security fixes land on the latest release line. Self-hosters should track the latest `almyty/api` and `almyty/frontend` image tags.

## What the platform already enforces

- Credentials and provider secrets are AES-256-GCM encrypted at rest (`ENCRYPTION_KEY`; Enterprise supports customer-managed keys).
- Auth tokens live in httpOnly cookies only — never in localStorage (regression-tested).
- Inbound channel webhooks are authenticated (HMAC signatures, platform JWTs, verification tokens) before any message reaches an agent.
- JavaScript tools run in a sandboxed `worker_threads` environment with a network guard.
- CI hard-blocks on `npm audit` findings (backend + frontend) and on secret scanning (gitleaks).

## Software bill of materials

Generate an SBOM for any release from the lockfiles:

```bash
cd backend && npm sbom --sbom-format cyclonedx > sbom-backend.json
cd frontend && npm sbom --sbom-format cyclonedx > sbom-frontend.json
```

This policy, together with the SBOM and update process above, is maintained with the EU Cyber Resilience Act's vendor obligations in mind. See `docs-site/content/compliance.mdx` (published on the docs site) for the broader compliance mapping, including the EU AI Act.
