#!/usr/bin/env node
// Starts fake upstreams on one port: node fakes/serve.ts <service>[,<service>] --port 4291 [--log file]
// stack.sh starts the ones the profile names.
import { parseArgs } from 'node:util'
import { serve } from './server.ts'
import { SERVICES } from './services/index.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string' }, log: { type: 'string' } } })
const names = (positionals[0] ?? '').split(',').filter(Boolean)
if (!names.length || !values.port) {
  console.error(`usage: node fakes/serve.ts <${Object.keys(SERVICES).join('|')}>[,...] --port <n> [--log <file>]`)
  process.exit(2)
}
const services = await Promise.all(names.map((n) => {
  const make = SERVICES[n]
  if (!make) throw new Error(`no fake called ${n}; there are ${Object.keys(SERVICES).join(', ')}`)
  return make()
}))
serve(services, { port: Number(values.port), log: values.log })
console.log(`fake ${names.join(', ')} on http://localhost:${values.port}`)
