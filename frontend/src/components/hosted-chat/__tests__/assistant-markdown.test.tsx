import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render, screen } from '@testing-library/react'

import { AssistantMarkdown } from '../assistant-markdown'

/**
 * Try it showed an answer's markdown as text: "**Conflicts**", "- 10:00 ...".
 * It is rendered now, the same way the hosted chat renders it.
 */
describe('AssistantMarkdown', () => {
  it('renders headings in bold and lists as lists, and drops raw HTML', async () => {
    const { container } = render(<AssistantMarkdown>{'**Conflicts**\n\n- 10:00 Investor call\n- 10:30 Dentist\n\n<img src=x onerror=alert(1)>'}</AssistantMarkdown>)

    expect((await screen.findByText('Conflicts', undefined, { timeout: 8000 })).tagName).toBe('STRONG')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('**')
  })

  it("is what an agent's Try it shows its answer with", () => {
    const source = readFileSync(join(__dirname, '../../agents/detail/overview-tab.tsx'), 'utf8')
    expect(source).toMatch(/<AssistantMarkdown>\{testOutput\}<\/AssistantMarkdown>/)
  })
})
