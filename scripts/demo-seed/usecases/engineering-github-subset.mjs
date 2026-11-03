#!/usr/bin/env node
// Cuts GitHub's published REST description (github/rest-api-description,
// MIT licensed) down to the operations the issue-triage and pull-request
// review examples use, and writes it where the docs offer it for download
// (docs-site/public/files/github-issues-and-pulls.openapi.json). almyty
// makes at most 1,000 tools from one description and GitHub's has more than
// 1,200 operations, so the examples connect this copy instead. Paths,
// parameters and schemas are GitHub's own, unchanged; only the other
// operations and the schemas nothing here uses are left out.
//
//   curl -sSLo api.github.com.json https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
//   node engineering-github-subset.mjs api.github.com.json docs-site/public/files/github-issues-and-pulls.openapi.json
import { readFileSync, writeFileSync } from 'node:fs'

export const OPERATIONS = [
  'issues/list-for-repo', 'issues/get', 'issues/list-labels-for-repo', 'issues/add-labels',
  'issues/list-comments', 'issues/create-comment', 'search/issues-and-pull-requests',
  'pulls/list', 'pulls/get', 'pulls/list-files', 'pulls/list-reviews', 'pulls/create-review',
]

const [src, out] = process.argv.slice(2)
const spec = JSON.parse(readFileSync(src, 'utf8'))
const paths = {}
for (const [p, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!OPERATIONS.includes(op?.operationId)) continue
    paths[p] ||= {}
    paths[p][method] = op
    if (item.parameters) paths[p].parameters = item.parameters
  }
}
// Keep every component the kept operations reach, and nothing else.
const keep = new Set()
const walk = (v) => {
  if (Array.isArray(v)) return v.forEach(walk)
  if (!v || typeof v !== 'object') return
  if (typeof v.$ref === 'string' && v.$ref.startsWith('#/components/')) {
    if (!keep.has(v.$ref)) {
      keep.add(v.$ref)
      const [, , kind, name] = v.$ref.split('/')
      walk(spec.components[kind]?.[name])
    }
  }
  for (const x of Object.values(v)) walk(x)
}
walk(paths)
const components = {}
for (const ref of keep) {
  const [, , kind, name] = ref.split('/')
  ;(components[kind] ||= {})[name] = spec.components[kind][name]
}
const missing = OPERATIONS.filter((id) => !Object.values(paths).some((i) => Object.values(i).some((o) => o?.operationId === id)))
if (missing.length) throw new Error(`not in the description: ${missing.join(', ')}`)
const subset = {
  openapi: spec.openapi,
  info: { ...spec.info, title: 'GitHub issues and pull requests', description: `The ${OPERATIONS.length} operations of GitHub's REST API description (github/rest-api-description, MIT licensed) that almyty's issue-triage and pull-request review examples use, unchanged.` },
  servers: spec.servers, externalDocs: spec.externalDocs, tags: spec.tags?.filter((t) => ['issues', 'pulls', 'search'].includes(t.name)),
  paths, components,
}
writeFileSync(out, JSON.stringify(subset, null, 1) + '\n')
console.log(`${OPERATIONS.length} operations, ${keep.size} components, ${(JSON.stringify(subset).length / 1024).toFixed(0)} KB`)
