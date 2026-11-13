/**
 * Removes what earlier gate runs left behind in the QA org: anything named
 * `gate-…`/`gate_…` and older than a day. A run deletes its own things as
 * each test ends; this catches what a crashed or killed run could not.
 *
 * The staging global setup runs it before every gate run; GATE_SWEEP_MAX_AGE_HOURS
 * changes the age (0 removes every gate-made thing).
 */
import { qaApi, qaOrg, list, deleteThing, GATE_NAME, type Kind } from './qa-api'

const ORDER: Kind[] = ['agent', 'gateway', 'mcp-source', 'tool', 'api', 'credential']

export async function sweep(maxAgeMs = 24 * 3600_000, log: (s: string) => void = console.log): Promise<number> {
  const org = qaOrg()
  const api = await qaApi(org.id)
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  try {
    for (const kind of ORDER) {
      let rows
      try {
        rows = await list(api, kind, org.id)
      } catch (err) {
        log(`sweep: cannot list ${kind}s: ${(err as Error).message}`)
        continue
      }
      for (const row of rows) {
        if (!GATE_NAME.test(row.name || '')) continue
        const created = row.createdAt ? Date.parse(row.createdAt) : 0
        if (created > cutoff) continue
        try {
          await deleteThing(api, kind, row.id, org.id)
          removed++
          log(`sweep: removed ${kind} ${row.name}`)
        } catch (err) {
          log(`sweep: ${(err as Error).message}`)
        }
      }
    }
  } finally {
    await api.dispose()
  }
  return removed
}
