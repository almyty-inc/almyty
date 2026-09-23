/**
 * Just enough JSX reading for source-guard tests.
 *
 * The repo's TypeScript is the native compiler (no JS API), so guards that
 * need "the visible label of every <Button>" read the source with this
 * small scanner instead: it finds an opening tag, skips its attributes
 * (tracking braces and quotes, so `onClick={() => x}` does not end the
 * tag at the arrow), then collects the literal text between it and the
 * matching close tag. Nested elements and `{expressions}` are dropped,
 * except string literals inside a ternary, which are real labels
 * (`{pending ? 'Saving…' : 'Save'}`).
 */
export interface JsxLabel {
  tag: string
  text: string
  /** Each alternative label when the text came from a ternary. */
  variants: string[]
  line: number
  /** Raw attribute source of the opening tag. */
  attrs: string
}

function skipBraces(src: string, i: number): number {
  // src[i] === '{'; returns index just past the matching '}'.
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? src.length : close + 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const close = src.indexOf('\n', i)
      i = close === -1 ? src.length : close
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return i
}

/** Index just past the `>` that ends the opening tag starting at `start`. */
function endOfOpeningTag(src: string, start: number): { end: number; selfClosing: boolean } {
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      i = skipBraces(src, i) - 1
    } else if (c === '"' || c === "'") {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++);
    } else if (c === '>') {
      return { end: i + 1, selfClosing: src[i - 1] === '/' }
    }
  }
  return { end: src.length, selfClosing: true }
}

function stringsInExpression(expr: string): string[] {
  // Only a plain string literal or a ternary of literals counts as label text.
  const trimmed = expr.trim()
  const literal = /^(['"`])([^'"`$]*)\1$/.exec(trimmed)
  if (literal) return [literal[2]]
  const ternary = /\?\s*(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3\s*$/.exec(trimmed)
  if (ternary) return [ternary[2], ternary[4]]
  return []
}

export function jsxLabels(src: string, tags: string[]): JsxLabel[] {
  const out: JsxLabel[] = []
  const opener = new RegExp(`<(${tags.join('|')})(?=[\\s>/])`, 'g')
  let m: RegExpExecArray | null
  while ((m = opener.exec(src))) {
    const tag = m[1]
    const { end, selfClosing } = endOfOpeningTag(src, m.index + 1 + tag.length)
    const attrs = src.slice(m.index + 1 + tag.length, end - 1)
    if (selfClosing) {
      out.push({ tag, text: '', variants: [], line: src.slice(0, m.index).split('\n').length, attrs })
      opener.lastIndex = end
      continue
    }
    // Walk children until the matching close tag, collecting literal text.
    let depth = 1
    let i = end
    let text = ''
    let variants: string[] = []
    while (i < src.length && depth > 0) {
      if (src.startsWith(`</${tag}>`, i)) {
        depth--
        i += tag.length + 3
        continue
      }
      const c = src[i]
      if (c === '{') {
        const close = skipBraces(src, i)
        const found = stringsInExpression(src.slice(i + 1, close - 1))
        if (found.length === 1) text += ' ' + found[0]
        else if (found.length > 1) variants = variants.concat(found)
        i = close
        continue
      }
      if (c === '<') {
        const sameTag = src.startsWith(`<${tag}`, i) && /[\s>/]/.test(src[i + 1 + tag.length] ?? '')
        const inner = endOfOpeningTag(src, i + 1)
        if (sameTag && !inner.selfClosing) depth++
        i = inner.end
        continue
      }
      text += c
      i++
    }
    const clean = text.replace(/\s+/g, ' ').trim()
    const all = [clean, ...variants.map((v) => `${clean} ${v}`.trim())].filter(Boolean)
    out.push({
      tag,
      text: clean,
      variants: variants.length ? all.slice(1) : all,
      line: src.slice(0, m.index).split('\n').length,
      attrs,
    })
    opener.lastIndex = end
  }
  return out
}

/**
 * Words allowed to keep a capital after the first word of a label:
 * acronyms, product and vendor names, and almyty's own proper nouns.
 */
export const LABEL_PROPER_NOUNS = new Set([
  'A2A', 'AI', 'API', 'APIs', 'AWS', 'Anthropic', 'Azure', 'BYOK', 'Bedrock', 'CLI', 'CSV', 'Claude',
  'Codex', 'Copilot', 'Cursor', 'Discord', 'Face', 'Gemini', 'GitHub', 'Google', 'GraphQL', 'HTTP',
  'Hugging', 'I', 'ID', 'IDs', 'IRC', 'JSON', 'JavaScript', 'KMS', 'LLM', 'MCP', 'Markdown', 'Matrix',
  'Microsoft', 'OAuth', 'OIDC', 'Ollama', 'OpenAI', 'OpenAPI', 'PDF', 'PNG', 'Petstore', 'Protobuf',
  'RBAC', 'REST', 'S3', 'SAML', 'SDK', 'SMS', 'SOAP', 'SQL', 'SSO', 'SVG', 'Signal', 'Slack', 'Stripe',
  'TOTP', 'Teams', 'Telegram', 'UTCP', 'URL', 'URLs', 'Vertex', 'WhatsApp', 'YAML', 'gRPC',
])

/** Multi-word names that keep their capitals: named surfaces and specs. */
export const LABEL_PROPER_PHRASES = ['Tool Hub', 'Agent Skills', 'Hugging Face', 'Google Chat', 'Microsoft Teams']

/** Words after the first that are capitalised without being a proper noun. */
export function titleCaseWords(label: string): string[] {
  let text = label
  for (const phrase of LABEL_PROPER_PHRASES) text = text.split(phrase).join('name')
  const words = text.split(/\s+/).filter(Boolean)
  return words.slice(1).filter((w) => {
    const bare = w.replace(/[^A-Za-z0-9]/g, '')
    return /^[A-Z][a-z]/.test(bare) && !LABEL_PROPER_NOUNS.has(bare)
  })
}
