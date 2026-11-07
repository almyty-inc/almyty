import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLlms } from './check-llms.mjs'
import { buildLlms, firstSentence, describe, absolutize } from './llms.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'llms-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  write('package.json', JSON.stringify({ scripts: { prebuild: 'node scripts/llms.mjs', build: 'next build' } }))
  write('.gitignore', '.next/\n/public/llms.txt\n/public/llms-full.txt\n')
  write('content/_meta.ts', `// top level
export default {
  index: 'Start here',
  tools: 'Tools',
  'ref-separator': { type: 'separator', title: 'Reference' },
  faq: 'FAQ',
}
`)
  write('content/index.mdx', '# Welcome\n\nalmyty turns your APIs into assistants. More text here.\n')
  write('content/faq.mdx', '# FAQ\n\n![shot](/screenshots/a.png)\n\nAnswers to the questions people ask most often.\n\nSee [tools](/tools).\n')
  write('content/tools/_meta.ts', "export default { index: 'Overview', http: 'HTTP' }\n")
  write('content/tools/index.mdx', '# Tools\n\nA tool is one thing an assistant can do.\n')
  write('content/tools/http.mdx', '# HTTP tools\n\nAn HTTP tool calls one address of a web API.\n')
  write('content/tools/graphql.mdx', '# GraphQL tools\n\nA GraphQL tool runs one query against a GraphQL API.\n')
  return { root, write, check: () => checkLlms(root) }
}

test('accepts a tree where every page is listed', (t) => {
  assert.deepEqual(fixture(t).check().errors, [])
})

test('lists pages in sidebar order, unlisted ones after, loose pages under their separator', (t) => {
  const f = fixture(t)
  const { index } = buildLlms(join(f.root, 'content'))
  const order = [...index.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1])
  assert.deepEqual(order, ['Welcome', 'Tools', 'HTTP tools', 'GraphQL tools', 'FAQ'])
  assert.match(index, /^# almyty docs\n\n> almyty turns your APIs into assistants\.\n/)
  assert.match(index, /## Tools\n\n- \[Tools\]\(https:\/\/docs\.almyty\.com\/tools\): A tool is one thing/)
  assert.match(index, /## Reference\n\n- \[FAQ\]\(https:\/\/docs\.almyty\.com\/faq\): Answers to the questions/)
})

test('the full text carries every page with absolute links', (t) => {
  const f = fixture(t)
  const { full } = buildLlms(join(f.root, 'content'))
  assert.match(full, /# FAQ\n\nSource: https:\/\/docs\.almyty\.com\/faq\n/)
  assert.match(full, /\(https:\/\/docs\.almyty\.com\/screenshots\/a\.png\)/)
  assert.match(full, /\[tools\]\(https:\/\/docs\.almyty\.com\/tools\)/)
  assert.equal(full.match(/^Source: /gm).length, 5)
})

test('rejects a _meta entry that names no page', (t) => {
  const f = fixture(t)
  f.write('content/tools/_meta.ts', "export default { index: 'Overview', http: 'HTTP', soap: 'SOAP' }\n")
  assert.match(f.check().errors.join('\n'), /tools\/_meta\.ts: "soap" names no page/)
})

test('rejects a page with nothing to describe it', (t) => {
  const f = fixture(t)
  f.write('content/tools/grpc.mdx', '# gRPC tools\n\n![only a picture](/x.png)\n')
  assert.match(f.check().errors.join('\n'), /tools\/grpc\.mdx: no first paragraph/)
})

test('rejects a build that no longer generates the files', (t) => {
  const f = fixture(t)
  f.write('package.json', JSON.stringify({ scripts: { build: 'next build' } }))
  assert.match(f.check().errors.join('\n'), /prebuild does not run scripts\/llms\.mjs/)
})

test('rejects committing the generated files', (t) => {
  const f = fixture(t)
  f.write('.gitignore', '.next/\n')
  assert.match(f.check().errors.join('\n'), /\/public\/llms\.txt is generated/)
})

test('a note is the first sentence, in plain words', () => {
  assert.equal(
    describe('# T\n\nA **tool** is one [thing](/x), e.g. `lookup`. Second sentence.\n').description,
    'A tool is one thing, e.g. lookup.',
  )
  assert.equal(firstSentence('It covers two things:'), 'It covers two things.')
  assert.equal(firstSentence('Ask "do we have 600 rolls? If so, reserve them", and get the answer. Next.'),
    'Ask "do we have 600 rolls? If so, reserve them", and get the answer.')
})

test('leaves full URLs and code alone when making links absolute', () => {
  assert.equal(absolutize('[a](https://x.y/z) [b](/p) <img src="/i.png" />'),
    '[a](https://x.y/z) [b](https://docs.almyty.com/p) <img src="https://docs.almyty.com/i.png" />')
})
