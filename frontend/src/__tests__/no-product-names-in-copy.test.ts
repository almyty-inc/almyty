/**
 * The app names no other product. Copy that says who can use a gateway or a
 * tool uses general words ("AI assistants, coding tools and other agents"),
 * and the per-client setup snippets on a gateway's page are labelled by kind
 * of client ("Command-line assistant", "Code editor (mcp.json)", "Desktop
 * assistant", "Any MCP client"). This reads every source file under src,
 * tests aside, so a name cannot come back in a new place either.
 *
 * Names that come from data (a runner reports the agents it found on its
 * machine) are not in the source and are not affected.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')

const PRODUCT_NAMES = /Claude Code|Claude Desktop|claude_desktop_config|Windsurf|Copilot|ChatGPT|VS Code|Codex|Gemini CLI|\.cursor\/|\bCursor\b/

/**
 * "Cursor" is also a word for a pagination position: the tool form's
 * pagination fields say "Cursor", "Cursor path" and "Cursor param".
 */
const ALLOWED: Array<{ file: string; line: RegExp }> = [
  { file: 'components/tools/tool-form.tsx', line: /value="cursor">Cursor<|label="Cursor (path|param)"/ },
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' || entry === 'test' ? [] : sourceFiles(path)
    }
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : []
  })
}

describe('the app names no other product', () => {
  const files = sourceFiles(SRC)

  it('reads the whole source tree', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.map((f) => relative(SRC, f))).toContain('lib/gateway-connect.ts')
  })

  it('has no product name in any source file', () => {
    const hits: string[] = []
    for (const path of files) {
      const file = relative(SRC, path)
      readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
        if (!PRODUCT_NAMES.test(line)) return
        if (ALLOWED.some((a) => a.file === file && a.line.test(line))) return
        hits.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('labels the gateway setup snippets by kind of client', () => {
    const source = readFileSync(join(SRC, 'lib/gateway-connect.ts'), 'utf8')
    for (const label of ['Command-line assistant', 'Code editor (mcp.json)', 'Desktop assistant', 'Any MCP client']) {
      expect(source).toContain(`label: '${label}'`)
    }
  })
})