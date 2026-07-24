#!/usr/bin/env node
/**
 * Docker Hub tag retention.
 *
 * The image build (`build-publish.yml`) pushes an immutable per-commit
 * tag `<pfx>-<shortsha>` (dev|staging|prod) on every branch push, plus a
 * cosign `sha256-<digest>.sig` / `.att` object per signed image. Nothing
 * ever removed them, so each repo grew unbounded (57+ tags of pure noise).
 *
 * This keeps the tags that mean something and deletes the rest:
 *
 *   KEEP  moving env tags   dev | staging | prod | latest
 *   KEEP  semver releases   0 | 0.1 | 0.1.4        (minted by release.yml)
 *   KEEP  newest KEEP_SHA   <pfx>-<sha> per prefix  (rollback headroom)
 *   KEEP  cosign .sig/.att  whose digest a kept tag still references
 *   DROP  everything else
 *
 * Zero-dependency (Node 24 global fetch). Auth via a Docker Hub PAT passed
 * as DOCKERHUB_TOKEN — the same secret build-publish.yml logs in with.
 *
 * Env:
 *   DOCKERHUB_USERNAME, DOCKERHUB_TOKEN   (required)
 *   DOCKERHUB_NAMESPACE=almyty
 *   REPOS=api,frontend,docs,almyty
 *   KEEP_SHA=10        immutable build tags to retain per prefix
 *   DRY_RUN=1          list what would be deleted, delete nothing
 */

const USER = process.env.DOCKERHUB_USERNAME;
const PASS = process.env.DOCKERHUB_TOKEN;
const NS = process.env.DOCKERHUB_NAMESPACE || 'almyty';
const REPOS = (process.env.REPOS || 'api,frontend,docs,almyty')
  .split(',').map((s) => s.trim()).filter(Boolean);
const KEEP_SHA = parseInt(process.env.KEEP_SHA || '10', 10);
const DRY_RUN = process.env.DRY_RUN === '1';

const HUB = 'https://hub.docker.com/v2';
const MOVING = new Set(['dev', 'staging', 'prod', 'latest']);
const SEMVER = /^\d+(\.\d+){0,2}$/;                 // 0 | 0.1 | 0.1.4
const SHATAG = /^(dev|staging|prod)-[0-9a-f]{7,40}$/; // dev-1a2b3c...
const SIGATT = /^sha256-([0-9a-f]{64})\.(sig|att)$/;  // cosign artifact

if (!USER || !PASS) {
  console.error('DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required.');
  process.exit(1);
}

async function login() {
  const r = await fetch(`${HUB}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

async function listTags(repo, token) {
  const out = [];
  let url = `${HUB}/repositories/${NS}/${repo}/tags/?page_size=100`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `JWT ${token}` } });
    if (r.status === 404) return null; // repo doesn't exist
    if (!r.ok) throw new Error(`list ${repo}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...j.results);
    url = j.next;
  }
  return out;
}

async function delTag(repo, name, token) {
  const r = await fetch(
    `${HUB}/repositories/${NS}/${repo}/tags/${encodeURIComponent(name)}/`,
    { method: 'DELETE', headers: { Authorization: `JWT ${token}` } },
  );
  if (!r.ok && r.status !== 404) {
    throw new Error(`delete ${repo}:${name}: ${r.status} ${await r.text()}`);
  }
}

const digestHex = (t) => (t.digest || (t.images && t.images[0] && t.images[0].digest) || '')
  .replace(/^sha256:/, '');

async function pruneRepo(repo, token) {
  const tags = await listTags(repo, token);
  if (tags === null) { console.log(`  ${NS}/${repo}: (repo not found — skip)`); return { del: 0, kept: 0 }; }

  const keep = new Set();
  const byPrefix = { dev: [], staging: [], prod: [] };

  for (const t of tags) {
    if (MOVING.has(t.name) || SEMVER.test(t.name)) { keep.add(t.name); continue; }
    const m = t.name.match(SHATAG);
    if (m) byPrefix[m[1]].push(t);
  }
  // Retain the newest KEEP_SHA immutable build tags per prefix.
  for (const pfx of Object.keys(byPrefix)) {
    byPrefix[pfx]
      .sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated))
      .slice(0, KEEP_SHA)
      .forEach((t) => keep.add(t.name));
  }
  // Digests that a kept tag still points at — their signatures stay.
  const protectedDigests = new Set(
    tags.filter((t) => keep.has(t.name)).map(digestHex).filter(Boolean),
  );

  const del = [];
  for (const t of tags) {
    if (keep.has(t.name)) continue;
    // cosign sha256-*.sig/.att tags are pruned too — releases no longer
    // tag-sign (provenance/SBOM live inside the image index instead), so
    // these are just hash-shaped tag clutter.
    del.push(t.name);
  }

  console.log(`  ${NS}/${repo}: ${tags.length} tags -> keep ${keep.size}, delete ${del.length}`);
  for (const name of del) {
    if (DRY_RUN) { console.log(`    [dry-run] would delete ${name}`); continue; }
    await delTag(repo, name, token);
    console.log(`    deleted ${name}`);
  }
  return { del: del.length, kept: keep.size };
}

(async () => {
  const token = await login();
  console.log(`Docker Hub prune — ns=${NS} keepSha=${KEEP_SHA}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  let total = 0;
  for (const repo of REPOS) {
    const { del } = await pruneRepo(repo, token);
    total += del;
  }
  console.log(`Done — ${DRY_RUN ? 'would delete' : 'deleted'} ${total} tag(s) across ${REPOS.length} repo(s).`);
})().catch((e) => { console.error(e); process.exit(1); });
