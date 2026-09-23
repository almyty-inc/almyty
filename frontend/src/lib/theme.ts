/**
 * The one place that decides whether the app is light or dark.
 *
 * Three mechanisms used to race here: `dashboard-layout.tsx` kept its own
 * `darkMode` useState defaulting to DARK, `store/app.ts` kept a `theme`
 * field defaulting to LIGHT, and both wrote the `dark` class onto <html>.
 * Neither consulted the browser at all -- `prefers-color-scheme` appeared
 * nowhere in the app -- so someone whose OS is in light mode was handed a
 * dark app and had to find the toggle.
 *
 * Now: 'system' follows the browser and is the default, and an explicit
 * 'light' or 'dark' overrides it until the person picks 'system' again.
 *
 * The class is applied a second time by an inline script in index.html,
 * before first paint, so the page never flashes the wrong palette while
 * React boots. That script duplicates `resolveTheme` deliberately -- it
 * cannot import from here -- so the two must be kept in step.
 */

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Reading localStorage can THROW rather than return null -- a private
 * window, blocked site data, a test environment with a window but no
 * working storage. Same reasoning as `readSetting` in store/app.ts.
 */
export function getStoredTheme(): Theme {
  try {
    if (typeof window === 'undefined') return 'system'
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    return 'system'
  }
}

export function storeTheme(theme: Theme): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    }
  } catch {
    // A preference we could not persist is not worth failing the click.
  }
}

/** What the browser is asking for right now. Defaults to light when it cannot say. */
export function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches
  } catch {
    return false
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme
  return systemPrefersDark() ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): ResolvedTheme {
  const resolved = resolveTheme(theme)
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    // `color-scheme` makes the browser's own chrome -- form controls,
    // scrollbars, the canvas behind the page -- match the palette. Without
    // it a dark page keeps light scrollbars.
    document.documentElement.style.colorScheme = resolved
  }
  return resolved
}

/**
 * Follow the OS while the preference is 'system'. Someone whose machine
 * switches at sunset expects the open tab to switch with it, not on next
 * reload.
 *
 * Returns an unsubscribe function; a no-op where matchMedia is missing.
 */
export function subscribeToSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {}
    const query = window.matchMedia(DARK_QUERY)
    const handler = (event: MediaQueryListEvent) => onChange(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  } catch {
    return () => {}
  }
}
