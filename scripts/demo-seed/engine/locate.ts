// Finding elements: by role and accessible name, label, placeholder, title
// or data-testid, the way a person or a screen reader finds them.
import type { Locator as PwLocator, Page } from '@playwright/test'
import type { Locator } from './schema.ts'

type Root = Page | PwLocator

/** Every element the locator matches. */
export function locateAll(root: Root, l: Locator): PwLocator {
  const base = l.within ? locate(root, l.within) : root
  const exact = l.exact
  let found: PwLocator
  if (l.role) {
    const opts = { ...(l.name !== undefined ? { name: l.name } : {}), ...(exact !== undefined ? { exact } : {}) }
    const roles = Array.isArray(l.role) ? l.role : [l.role]
    found = roles.slice(1).reduce((acc, r) => acc.or(base.getByRole(r, opts)), base.getByRole(roles[0], opts))
  }
  else if (l.label !== undefined) found = base.getByLabel(l.label, { exact })
  else if (l.placeholder !== undefined) found = base.getByPlaceholder(l.placeholder, { exact })
  else if (l.testid !== undefined) found = base.getByTestId(l.testid)
  else if (l.title !== undefined) found = base.getByTitle(l.title, { exact })
  else if (l.text !== undefined) found = base.getByText(l.text, { exact })
  else throw new Error('empty locator')
  return l.hasText !== undefined ? found.filter({ hasText: l.hasText }) : found
}

/** The one element a step means: the first match unless nth says otherwise. */
export function locate(root: Root, l: Locator): PwLocator {
  const all = locateAll(root, l)
  return l.nth === 'last' ? all.last() : typeof l.nth === 'number' ? all.nth(l.nth) : all.first()
}

/** A locator as a reader would say it: button "Save", label "API key". */
export function describe(l: Locator): string {
  const v = (x: unknown) => (x instanceof RegExp ? String(x) : JSON.stringify(x))
  const kind = l.role ? `${([] as string[]).concat(l.role).join(' or ')}${l.name !== undefined ? ` ${v(l.name)}` : ''}`
    : l.label !== undefined ? `label ${v(l.label)}`
      : l.placeholder !== undefined ? `placeholder ${v(l.placeholder)}`
        : l.testid !== undefined ? `testid ${v(l.testid)}`
          : l.title !== undefined ? `title ${v(l.title)}` : `text ${v(l.text)}`
  const extra = [l.hasText !== undefined ? `with text ${v(l.hasText)}` : '', l.nth !== undefined && l.nth !== 'first' ? `(${l.nth})` : ''].filter(Boolean).join(' ')
  return `${l.within ? `${describe(l.within)} > ` : ''}${kind}${extra ? ` ${extra}` : ''}`
}
