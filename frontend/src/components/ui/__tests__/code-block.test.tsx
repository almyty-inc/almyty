import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { CodeBlock } from '../code-block'

const command = 'claude mcp add petstore --transport http https://api.example/acme/petstore --header "x-api-key: sk-123"'

describe('CodeBlock', () => {
  it('wraps long lines by default, so the end of a command is never out of sight', () => {
    const { container } = render(<CodeBlock value={command} language="bash" />)
    expect(screen.getByTestId('code-block')).toHaveAttribute('data-wrap', 'true')
    expect(container.querySelector('.cm-content')).toHaveClass('cm-lineWrapping')
  })

  it('scrolls instead when asked not to wrap', () => {
    const { container } = render(<CodeBlock value={command} language="bash" wrap={false} />)
    expect(screen.getByTestId('code-block')).toHaveAttribute('data-wrap', 'false')
    expect(container.querySelector('.cm-content')).not.toHaveClass('cm-lineWrapping')
  })

  it('is not told to stop wrapping on the gateway page', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'gateways', 'connect-snippets.tsx'), 'utf8')
    expect(src).toContain('<CodeBlock')
    expect(src).not.toMatch(/wrap=\{false\}/)
  })
})
