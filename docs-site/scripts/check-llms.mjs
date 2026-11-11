// Fails when /llms.txt or /llms-full.txt would leave a docs page out.
//
//   node docs-site/scripts/check-llms.mjs
//
// Both files are generated at build time by scripts/llms.mjs (prebuild), so
// they cannot drift from the content tree. This check keeps the generator
// honest: every .mdx under content/ is listed once in the index, with a
// title and a one-line note, and appears once in the full text; every
// _meta.ts entry names a page or folder that exists (a stale entry would
// silently drop out of both); and the build still runs the generator.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLlms, contentFiles, readMeta, DOCS_URL } from './llms.mjs'

const routeOf = (file) => file.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')

export function checkLlms(siteRoot) {
  const errors = []
  const contentDir = join(siteRoot, 'content')
  const { sections, index, full } = buildLlms(contentDir)
  const pages = sections.flatMap((s) => s.pages)

  for (const file of contentFiles(contentDir)) {
    const route = routeOf(file)
    const url = route ? `${DOCS_URL}/${route}` : `${DOCS_URL}/`
    const listed = index.split('\n').filter((l) => l.includes(`](${url})`)).length
    if (listed !== 1) errors.push(`content/${file}: listed ${listed} times in llms.txt, want 1`)
    const inFull = full.split('\n').filter((l) => l === `Source: ${url}`).length
    if (inFull !== 1) errors.push(`content/${file}: appears ${inFull} times in llms-full.txt, want 1`)
    const page = pages.find((p) => p.file === file)
    if (page && !page.description) errors.push(`content/${file}: no first paragraph to describe it in llms.txt`)
    if (page && page.title === page.route) errors.push(`content/${file}: no "# " heading to title it in llms.txt`)
  }

  const walk = (dir, rel) => {
    const meta = readMeta(dir)
    for (const [key, entry] of Object.entries(meta)) {
      if (entry && typeof entry === 'object' && (entry.type === 'separator' || typeof entry.href === 'string')) continue
      const isPage = existsSync(join(dir, `${key}.mdx`))
      const isFolder = existsSync(join(dir, key)) && statSync(join(dir, key)).isDirectory()
      if (!isPage && !isFolder) errors.push(`content/${rel}_meta.ts: "${key}" names no page or folder`)
    }
    for (const name of readdirSync(dir)) {
      if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), `${rel}${name}/`)
    }
  }
  walk(contentDir, '')

  if (!index.startsWith('# ')) errors.push('llms.txt does not open with an H1')
  if (!/\n> \S/.test(index)) errors.push('llms.txt has no blockquote summary')

  const pkg = JSON.parse(readFileSync(join(siteRoot, 'package.json'), 'utf8'))
  if (!/\bnode scripts\/llms\.mjs\b/.test(pkg.scripts?.prebuild ?? '')) {
    errors.push('docs-site/package.json: prebuild does not run scripts/llms.mjs, so the build would ship no llms.txt')
  }
  const ignored = readFileSync(join(siteRoot, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
  for (const out of ['/public/llms.txt', '/public/llms-full.txt']) {
    if (!ignored.includes(out)) errors.push(`docs-site/.gitignore: ${out} is generated and must not be committed`)
  }
  return { errors, pages: pages.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, pages } = checkLlms(join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (errors.length) {
    for (const e of errors) console.error(`llms: ${e}`)
    process.exit(1)
  }
  console.log(`llms: all ${pages} docs pages are in llms.txt and llms-full.txt`)
}
