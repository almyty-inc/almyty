import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  applyTheme,
  getStoredTheme,
  resolveTheme,
  subscribeToSystemTheme,
  systemPrefersDark,
} from '../theme'

/**
 * The app used to hardcode dark and never ask the browser:
 *
 *   // Dark is the default; only light if explicitly stored
 *   return localStorage.getItem('theme') !== 'light'
 *
 * `prefers-color-scheme` appeared nowhere in the frontend, so anyone whose
 * OS was in light mode got a dark app and had to go find the toggle.
 */

function mockPrefersDark(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = []
  const mql = {
    matches,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return {
    listenerCount: () => listeners.length,
    emit: (nowDark: boolean) => {
      mql.matches = nowDark
      listeners.forEach((fn) => fn({ matches: nowDark } as MediaQueryListEvent))
    },
  }
}

describe('the theme follows the browser unless the person overrides it', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.colorScheme = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to the browser preference rather than to dark', () => {
    mockPrefersDark(false)
    expect(getStoredTheme()).toBe('system')
    applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('goes dark when the browser asks for dark', () => {
    mockPrefersDark(true)
    applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('lets an explicit choice beat the browser, in both directions', () => {
    mockPrefersDark(true)
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    mockPrefersDark(false)
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('sets color-scheme so the browser chrome matches', () => {
    mockPrefersDark(true)
    applyTheme('system')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('follows the OS live while the preference is system', () => {
    const media = mockPrefersDark(false)
    const unsubscribe = subscribeToSystemTheme(() => applyTheme('system'))

    media.emit(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    media.emit(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    unsubscribe()
    expect(media.listenerCount()).toBe(0)
  })

  it('ignores a stored value that is not a theme', () => {
    localStorage.setItem('theme', 'chartreuse')
    expect(getStoredTheme()).toBe('system')
  })

  it('survives storage that throws rather than returning null', () => {
    const boom = () => {
      throw new Error('SecurityError: site data blocked')
    }
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({ getItem: boom, setItem: boom }),
    })

    mockPrefersDark(true)
    expect(() => getStoredTheme()).not.toThrow()
    expect(getStoredTheme()).toBe('system')
    expect(resolveTheme('system')).toBe('dark')

    if (original) Object.defineProperty(window, 'localStorage', original)
  })

  it('reports light when the browser cannot say', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(systemPrefersDark()).toBe(false)
    expect(resolveTheme('system')).toBe('light')
  })
})

/**
 * The class is set twice: once by an inline script in index.html before
 * first paint (so the page never flashes the wrong palette) and once by
 * React. The script cannot import from theme.ts, so a source guard is the
 * only thing keeping the duplicate honest.
 */
describe('index.html paints the right theme before React boots', () => {
  const html = readFileSync(join(__dirname, '..', '..', '..', 'index.html'), 'utf8')

  it('consults the browser preference inline', () => {
    expect(html).toContain('prefers-color-scheme: dark')
  })

  it('runs the theme script before the app bundle', () => {
    const script = html.indexOf('prefers-color-scheme')
    // A missing script is -1, which is "before" everything; rule that out.
    expect(script).toBeGreaterThan(-1)
    expect(script).toBeLessThan(html.indexOf('/src/main.tsx'))
  })

  it('treats an explicit stored choice as the override', () => {
    expect(html).toContain("stored === 'dark'")
    expect(html).toContain("stored !== 'light'")
  })
})

/**
 * Four simultaneous entrance animations -- fade, zoom, slide-from-left-1/2
 * and slide-from-top-48% -- made every dialog swoop in diagonally while
 * scaling. The slides existed only to cancel the -50% centring transforms.
 */
describe('dialogs fade, they do not fly', () => {
  const dialog = readFileSync(
    join(__dirname, '..', '..', 'components', 'ui', 'dialog.tsx'),
    'utf8',
  )
  // The file documents the old classes in a comment; judge the code only.
  const code = dialog.replace(/\/\*[\s\S]*?\*\//g, '')

  it('does not slide or zoom the dialog into place', () => {
    expect(code).not.toContain('slide-in-from-left')
    expect(code).not.toContain('slide-in-from-top')
    expect(code).not.toContain('zoom-in-95')
  })

  it('fades in, and closes instantly (#127: an exit animation left dialogs stuck on screen)', () => {
    expect(code).toContain('data-[state=open]:fade-in-0')
    expect(code).not.toContain('data-[state=closed]')
  })

  it('honours a request for less motion', () => {
    expect(code).toContain('motion-reduce:animate-none')
  })
})

/**
 * The hardcoded dark default lived in the layout, not in a helper:
 *
 *   // Dark is the default; only light if explicitly stored
 *   return localStorage.getItem('theme') !== 'light'
 *
 * and a second, disagreeing default lived in store/app.ts. Pin both to the
 * one module so a third mechanism cannot grow back beside it.
 */
describe('there is one theme mechanism', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf8')

  it('the layout no longer decides the default itself', () => {
    const layout = read('components', 'layout', 'dashboard-layout.tsx')
    expect(layout).not.toMatch(/localStorage\.getItem\(['"]theme['"]\)/)
    expect(layout).not.toMatch(/classList\.(add|remove)\(['"]dark['"]\)/)
    expect(layout).toContain('applyTheme')
  })

  it('the store starts from the stored preference, not a hardcoded theme', () => {
    const store = read('store', 'app.ts')
    expect(store).toContain('theme: getStoredTheme()')
    expect(store).not.toMatch(/classList\.(add|remove)\(['"]dark['"]\)/)
  })
})
