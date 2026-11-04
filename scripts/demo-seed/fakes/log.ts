// A fake's own log (what its scripted model decided), one line per entry.
// It writes only on a stack: to the file `envVar` names, else to `fileName`
// in LOG_DIR (stack.sh sets it). Without either, as in the tests, it writes
// nothing. A log that cannot be written never fails a request.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function fakeLog(envVar: string, fileName: string): (line: string) => void {
  return (line) => {
    const file = process.env[envVar] || (process.env.LOG_DIR ? join(process.env.LOG_DIR, fileName) : '')
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`)
    } catch { /* a log is not worth a failed request */ }
  }
}
