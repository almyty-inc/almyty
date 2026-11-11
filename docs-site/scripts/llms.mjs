// Builds /llms.txt and /llms-full.txt (https://llmstxt.org) from the docs
// content tree, so the two files list exactly the pages the site serves.
//
//   node scripts/llms.mjs          writes public/llms.txt and public/llms-full.txt
//
// `npm run build` runs this first (prebuild), and scripts/check-llms.mjs
// fails `npm run check` when a page is missing from either file. The order
// is the sidebar's: each folder's _meta.ts, then any page it does not name.
// A page's title is its first heading, its note the first sentence of its
// first paragraph. Both outputs are build artifacts and are not committed.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const DOCS_URL = 'https://docs.almyty.com'
export const APP_LLMS_URL = 'https://app.almyty.com/llms.txt'

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A folder's _meta.ts: a plain object literal behind `export default`. */
export function readMeta(dir) {
  let src
  try {
    src = readFileSync(join(dir, '_meta.ts'), 'utf8')
  } catch {
    return {}
  }
  const body = src.replace(/^\s*export\s+default\s+/m, 'module.exports = ')
  const sandbox = { module: { exports: {} } }
  vm.runInNewContext(body, sandbox, { filename: join(dir, '_meta.ts') })
  return sandbox.module.exports
}

function metaTitle(entry) {
  if (typeof entry === 'string') return entry
  return entry && typeof entry.title === 'string' ? entry.title : undefined
}

function isSeparator(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.type === 'separator')
}

function isLink(entry) {
  return Boolean(entry && typeof entry === 'object' && typeof entry.href === 'string')
}

/** Frontmatter (`---` fenced `key: value` lines), if the file opens with it. */
export function splitFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { data: {}, body: src }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  return { data, body: src.slice(m[0].length) }
}

/** Markdown inline syntax down to plain words. */
export function plain(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The first sentence of a paragraph, kept whole; long ones are cut at a
 * word. A sentence ends at a full stop before a space, past the first few
 * words and not after an abbreviation, so a question quoted mid-sentence
 * or "e.g." does not cut it short. A trailing colon (the paragraph leads
 * into a list) becomes a full stop.
 */
export function firstSentence(text, max = 300) {
  const re = /\.(?=\s|$)/g
  let m
  while ((m = re.exec(text))) {
    if (m.index >= 30 && !/\b(e\.g|i\.e|etc|vs)$/i.test(text.slice(0, m.index))) {
      text = text.slice(0, m.index + 1)
      break
    }
  }
  text = text.replace(/:$/, '.')
  if (text.length <= max) return text
  return text.slice(0, text.lastIndexOf(' ', max - 3)) + '...'
}

/** Title (first `# ` heading) and first prose paragraph of a page body. */
export function describe(body) {
  let title
  const paragraph = []
  let fence = false
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fence = !fence
      if (paragraph.length) break
      continue
    }
    if (fence) continue
    if (!title) {
      const h = /^#\s+(.+)$/.exec(line)
      if (h) {
        title = plain(h[1])
        continue
      }
    }
    if (!line) {
      if (paragraph.length) break
      continue
    }
    const prose = !/^(#|!\[|<|\||>|import\s|export\s|[-*+]\s|\d+\.\s|---)/.test(line)
    if (!prose) {
      if (paragraph.length) break
      continue
    }
    paragraph.push(line)
  }
  return { title, description: paragraph.length ? firstSentence(plain(paragraph.join(' '))) : '' }
}

function pageUrl(route) {
  return route === '' ? `${DOCS_URL}/` : `${DOCS_URL}/${route}`
}

function readPage(contentDir, file, route, fallbackTitle) {
  const src = readFileSync(join(contentDir, file), 'utf8')
  const { data, body } = splitFrontmatter(src)
  const found = describe(body)
  return {
    file,
    route,
    url: pageUrl(route),
    title: data.title || found.title || fallbackTitle || route,
    description: data.description || found.description,
    body,
  }
}

/** The .mdx files and subfolders of one content folder, in sidebar order. */
function orderedEntries(contentDir, rel) {
  const dir = join(contentDir, rel)
  const meta = readMeta(dir)
  const names = readdirSync(dir)
  const pages = new Set(names.filter((n) => n.endsWith('.mdx')).map((n) => n.slice(0, -4)))
  const folders = new Set(names.filter((n) => statSync(join(dir, n)).isDirectory()))
  const out = []
  const seen = new Set()
  for (const [key, entry] of Object.entries(meta)) {
    if (isSeparator(entry)) {
      out.push({ kind: 'separator', title: entry.title })
      continue
    }
    if (isLink(entry)) continue
    if (pages.has(key)) out.push({ kind: 'page', key, title: metaTitle(entry) })
    else if (folders.has(key)) out.push({ kind: 'folder', key, title: metaTitle(entry) })
    else continue
    seen.add(key)
  }
  // Nextra lists what _meta.ts leaves out after what it names.
  const rest = [...pages, ...folders].filter((k) => !seen.has(k)).sort((a, b) => {
    if (a === 'index') return -1
    if (b === 'index') return 1
    return a.localeCompare(b)
  })
  for (const key of rest) out.push({ kind: pages.has(key) ? 'page' : 'folder', key })
  return out
}

/**
 * Every docs page, grouped the way the sidebar groups them: a folder is a
 * section titled as the sidebar titles it; a loose top-level page sits in
 * the section of the separator above it (the first page's own title before
 * the first separator).
 */
export function collectSections(contentDir = join(siteRoot, 'content')) {
  const sections = []
  const byTitle = new Map()
  const section = (title) => {
    if (!byTitle.has(title)) {
      const s = { title, pages: [] }
      byTitle.set(title, s)
      sections.push(s)
    }
    return byTitle.get(title)
  }

  const walk = (rel, into) => {
    for (const entry of orderedEntries(contentDir, rel)) {
      if (entry.kind === 'separator') continue
      const childRel = `${rel}/${entry.key}`
      if (entry.kind === 'folder') walk(childRel, into)
      else into.pages.push(readPage(contentDir, `${childRel}.mdx`, entry.key === 'index' ? rel : childRel, entry.title))
    }
  }

  let group
  for (const entry of orderedEntries(contentDir, '')) {
    if (entry.kind === 'separator') {
      group = entry.title
      continue
    }
    if (entry.kind === 'folder') {
      walk(entry.key, section(entry.title || entry.key))
      continue
    }
    const route = entry.key === 'index' ? '' : entry.key
    const page = readPage(contentDir, `${entry.key}.mdx`, route, entry.title)
    if (!group) group = entry.title || page.title
    section(group).pages.push(page)
  }
  return sections.filter((s) => s.pages.length)
}

/** Every .mdx file under the content folder, relative to it. */
export function contentFiles(contentDir = join(siteRoot, 'content')) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.mdx')) out.push(relative(contentDir, full).split('\\').join('/'))
    }
  }
  walk(contentDir)
  return out.sort()
}

export function renderIndex(sections) {
  const home = sections.flatMap((s) => s.pages).find((p) => p.route === '')
  const lines = [
    '# almyty docs',
    '',
    `> ${home?.description || 'Documentation for almyty, the open platform for AI agents.'}`,
    '',
    'This is the documentation for almyty: how to connect APIs, build agents, put them in chat apps and on websites, run them safely, and call almyty from code. Each link below is one page, with the first sentence of that page.',
    '',
    `- The full text of every page in one file: ${DOCS_URL}/llms-full.txt`,
    `- How a program or AI agent uses almyty (API, keys, MCP, CLIs): ${APP_LLMS_URL}`,
  ]
  for (const s of sections) {
    lines.push('', `## ${s.title}`, '')
    for (const p of s.pages) {
      lines.push(`- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ''}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** Root-relative links and images, made absolute so they work off the site. */
export function absolutize(markdown) {
  return markdown
    .replace(/\]\(\/(?!\/)/g, `](${DOCS_URL}/`)
    .replace(/(href|src)="\/(?!\/)/g, `$1="${DOCS_URL}/`)
}

/** MDX module lines (import/export outside code fences) carry no prose. */
function stripModuleLines(body) {
  let fence = false
  return body
    .split('\n')
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence
      return fence || !/^(import|export)\s/.test(line)
    })
    .join('\n')
}

export function renderFull(sections) {
  const parts = [
    '# almyty docs, full text',
    '',
    `> Every page of ${DOCS_URL}, in sidebar order. The page index is ${DOCS_URL}/llms.txt.`,
  ]
  for (const s of sections) {
    for (const p of s.pages) {
      let body = absolutize(stripModuleLines(p.body)).trim()
      const h1 = /^#\s+.+$/m.exec(body)
      if (h1 && h1.index === 0) body = body.slice(h1[0].length).trim()
      parts.push('', '---', '', `# ${p.title}`, '', `Source: ${p.url}`, `Section: ${s.title}`, '', body)
    }
  }
  return parts.join('\n') + '\n'
}

export function buildLlms(contentDir) {
  const sections = collectSections(contentDir)
  return { sections, index: renderIndex(sections), full: renderFull(sections) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { sections, index, full } = buildLlms()
  const out = join(siteRoot, 'public')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'llms.txt'), index)
  writeFileSync(join(out, 'llms-full.txt'), full)
  const count = sections.reduce((n, s) => n + s.pages.length, 0)
  console.log(`llms: ${count} pages in ${sections.length} sections -> public/llms.txt, public/llms-full.txt`)
}
