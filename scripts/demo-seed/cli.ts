#!/usr/bin/env node
// The demo stack's one entry point. See README.md.
//
//   npm run demo -- check                         walks parse, and agree with the manifest
//   npm run demo -- list                          walks, their profile and screenshots
//   npm run demo -- seed  [--only <walk,...>]     the headless walks of the running profile
//   npm run demo -- capture [--only <walk,...>] [--from <shot>]
//   npm run demo -- compare [--only <walk,...>]     captures against the published images
//   npm run demo -- register [--only <walk,...>] [shot ...]
//   npm run demo -- profile <name>                what stack.sh starts for a profile
import { parseArgs } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { load, plan } from './engine/load.ts'
import { checkCoverage, readManifest } from './engine/manifest.ts'
import { readEnv, stackEnv, ROOT, HERE } from './engine/env.ts'
import { runWalk, readCaptures, readVars, WalkError } from './engine/run.ts'
import type { Vars } from './engine/template.ts'
import { register } from './engine/register.ts'
import { compare } from './engine/compare.ts'
import { FAMILIES } from './walks/index.ts'
import { PROFILES, profileLines } from './walks/profiles.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { only: { type: 'string' }, from: { type: 'string' }, profile: { type: 'string' } },
})
const [command = 'check', ...rest] = positionals
const loaded = load(FAMILIES)
const env = ['seed', 'capture', 'compare', 'register'].includes(command) ? stackEnv() : readEnv()
const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean)

// The profile stack.sh started, written to its log directory.
function runningProfile(): string {
  if (values.profile) return values.profile
  const file = join(process.env.LOG_DIR || '/tmp/almyty-demo', 'profile')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : 'northwind'
}

function selected(headless?: boolean) {
  const profile = runningProfile()
  const ids = only ?? loaded.walks.filter((w) => w.profile === profile && (headless === undefined || Boolean(w.headless) === headless)).map((w) => w.id)
  // Only the walks asked for, in order; one they run after but that is not asked for lends what it remembered last time.
  const walks = plan(loaded, ids).filter((w) => ids.includes(w.id))
  const wrong = walks.filter((w) => w.profile !== profile)
  if (wrong.length) throw new Error(`the stack runs profile ${profile}; ${wrong.map((w) => `${w.id} needs ${w.profile}`).join(', ')} (PROFILE=${wrong[0].profile} scripts/demo-seed/stack.sh up)`)
  return walks
}

async function walkAll(headless?: boolean) {
  const walks = selected(headless)
  const needsBrowser = walks.some((w) => !w.headless)
  const require = createRequire(join(HERE, 'package.json'))
  const { chromium } = require('@playwright/test') as typeof import('@playwright/test')
  const browser = needsBrowser ? await chromium.launch() : undefined
  let failed = 0
  try {
    const remembered = new Map<string, Vars>()
    for (const w of walks) {
      console.log(`walk ${w.id}: ${w.title}`)
      try {
        const vars: Vars = {}
        for (const dep of w.after ?? []) {
          const v = remembered.get(dep) ?? readVars(env.out, dep)
          if (!v) throw new Error(`walk ${w.id} runs after ${dep}, which has not run on this stack yet (npm run demo -- capture --only ${dep})`)
          Object.assign(vars, v)
        }
        const from = w.id === walks.at(-1)?.id ? values.from : undefined
        if (from) Object.assign(vars, readVars(env.out, w.id) ?? {})
        const run = await runWalk(w, { env, browser, actions: loaded.actions, templates: loaded.templates, from, vars })
        remembered.set(w.id, run.vars)
        console.log(`walk ${w.id}: ${Object.keys(run.captures).length} screenshots in ${run.out}`)
      } catch (e) {
        failed++
        console.error(e instanceof WalkError ? e.message : e)
        // Later walks build on earlier ones.
        break
      }
    }
  } finally { await browser?.close() }
  if (failed) process.exitCode = 1
}

switch (command) {
  case 'check': {
    const problems = checkCoverage(loaded.walks, readManifest(ROOT))
    for (const p of problems) console.error(p)
    const shots = loaded.walks.reduce((n, w) => n + Object.keys(w.shots).length, 0)
    console.log(`${loaded.walks.length} walks, ${shots} screenshots, ${problems.length} problems`)
    process.exitCode = problems.length ? 1 : 0
    break
  }
  case 'list':
    for (const w of loaded.walks) console.log(`${w.id.padEnd(26)} ${w.profile.padEnd(11)} ${String(Object.keys(w.shots).length).padStart(3)} shots  ${w.title}`)
    break
  case 'seed': await walkAll(true); break
  case 'capture': await walkAll(); break
  case 'register': {
    const captures = readCaptures(env.out)
    for (const w of only ? plan(loaded, only).filter((x) => only.includes(x.id)) : loaded.walks) {
      if (captures[w.id]) register(w, captures[w.id], rest)
    }
    break
  }
  case 'compare': {
    // Each capture beside the image it would replace: the share of pixels that changed, and a picture of where.
    const require = createRequire(join(HERE, 'package.json'))
    const { chromium } = require('@playwright/test') as typeof import('@playwright/test')
    const browser = await chromium.launch()
    const captures = readCaptures(env.out)
    try {
      for (const w of only ? loaded.walks.filter((x) => only.includes(x.id)) : loaded.walks) {
        for (const [id, c] of Object.entries(captures[w.id] ?? {})) {
          const shot = w.shots[id]
          if (!shot) continue
          const published = join(ROOT, 'docs-site/public', shot.path)
          if (!existsSync(published)) { console.log(`${w.id}/${id}  new (nothing published yet)`); continue }
          const d = await compare(browser, published, c.file, c.file.replace(/\.png$/, '.diff.png'))
          const how = d.sizes ? `size ${d.sizes[0]} -> ${d.sizes[1]}` : d.same ? 'same' : `${(d.changed * 100).toFixed(2)}% changed in ${d.box!.width}x${d.box!.height} at ${d.box!.x},${d.box!.y}`
          console.log(`${w.id}/${id}  ${how}`)
        }
      }
    } finally { await browser.close() }
    break
  }
  case 'profile': {
    const name = rest[0] ?? 'northwind'
    if (!PROFILES[name]) throw new Error(`no profile called ${name}; there are ${Object.keys(PROFILES).join(', ')}`)
    console.log(profileLines(name).join('\n'))
    break
  }
  default:
    console.error(`unknown command ${command}; see scripts/demo-seed/README.md`)
    process.exitCode = 2
}
// Done: a process an action started (a runner, a fake) does not keep the CLI alive.
process.exit(process.exitCode ?? 0)
