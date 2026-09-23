/* Keyboard shortcuts: the `?` key, and the list it opens.
 *
 * `?` (Shift+/) from anywhere that isn't an editable field goes to
 * /shortcuts -- same key as GitHub, Slack and Linear. It used to open a
 * dialog; it is a page now (no dialogs), so the list has a URL and Back
 * returns to where you were.
 *
 * The list names only shortcuts that exist. The dialog advertised
 * "G then D", "N" and "/" too, and nothing ever handled them.
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export interface Shortcut {
  keys: string[]
  label: string
}

export const SHORTCUTS: { group: string; entries: Shortcut[] }[] = [
  {
    group: 'Navigation',
    entries: [{ keys: ['⌘', 'K'], label: 'Open the command palette (Ctrl+K on Windows and Linux)' }],
  },
  {
    group: 'Help',
    entries: [{ keys: ['?'], label: 'Show this list' }],
  },
  {
    group: 'Everywhere',
    entries: [{ keys: ['Esc'], label: 'Close the command palette or a confirmation' }],
  },
]

export const SHORTCUTS_PATH = '/shortcuts'

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  // cmdk renders its input with role="combobox"; don't hijack while typing
  if (el.getAttribute('role') === 'combobox') return true
  return false
}

/** Mounted once in the dashboard layout: `?` goes to the shortcuts page. */
export function KeyboardShortcutsListener() {
  const navigate = useNavigate()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isEditable(e.target)) {
        e.preventDefault()
        navigate(SHORTCUTS_PATH)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [navigate])

  return null
}

/** The list itself; the /shortcuts page renders it. */
export function ShortcutList() {
  return (
    <div className="space-y-6">
      {SHORTCUTS.map((group) => (
        <section key={group.group} className="rounded-xl border bg-card p-4 sm:p-6">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.group}
          </h2>
          <ul className="space-y-3">
            {group.entries.map((entry) => (
              <li key={entry.label} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-foreground">{entry.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {entry.keys.map((k, i) => (
                    <kbd
                      key={i}
                      className="inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-border/80 bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
