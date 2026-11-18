import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AlmytyMark } from '../almyty-logo'

const layoutDir = join(__dirname, '..')
const publicDir = join(__dirname, '../../../../public')

describe('almyty logo in app chrome', () => {
  it('renders the bare mark, not the favicon tile', () => {
    const { container } = render(<AlmytyMark label="almyty" />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/almyty-mark.svg')
    expect(img.getAttribute('alt')).toBe('almyty')
  })

  it('is decorative when unlabelled', () => {
    const { container } = render(<AlmytyMark />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps the dark favicon tile out of the sidebar, top bar and sign-in pages', () => {
    for (const file of ['dashboard-layout.tsx', 'auth-layout.tsx']) {
      const src = readFileSync(join(layoutDir, file), 'utf-8')
      expect(src, file).not.toContain('almyty-icon-48.svg')
      expect(src, file).toContain('<AlmytyMark')
    }
  })

  it('ships the mark as the brand spec draws it: hollow bolt, no tile', () => {
    const svg = readFileSync(join(publicDir, 'almyty-mark.svg'), 'utf-8')
    expect(svg).toContain('points="10,0 20,0 12,12 19,12 6,26 12,12 4,12"')
    expect(svg).toContain('fill="none"')
    expect(svg).not.toContain('<rect')
    for (const c of ['#8b5cf6', '#22d3ee', '#a78bfa', '#7c3aed']) expect(svg).toContain(c)
  })
})
