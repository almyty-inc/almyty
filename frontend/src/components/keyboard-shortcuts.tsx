/* Keyboard shortcuts help dialog.
 *
 * Opens on `?` (Shift+/) from anywhere that isn't an editable
 * field — same convention as GitHub, Slack, Linear. Closes on
 * Escape. Also exposes a programmatic open handle for the
 * sidebar help icon once that lands.
 */
import { useEffect, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Shortcut {
  keys: string[]
  label: string
}

const shortcuts: { group: string; entries: Shortcut[] }[] = [
  {
    group: 'Navigation',
    entries: [
      { keys: ['⌘', 'K'], label: 'Open the command palette' },
      { keys: ['G', 'D'], label: 'Go to Dashboard' },
      { keys: ['G', 'A'], label: 'Go to Agents' },
      { keys: ['G', 'T'], label: 'Go to Tools' },
      { keys: ['G', 'P'], label: 'Go to APIs' },
      { keys: ['G', 'Y'], label: 'Go to Gateways' },
    ],
  },
  {
    group: 'Actions',
    entries: [
      { keys: ['N'], label: 'Create new (on any list page)' },
      { keys: ['/'], label: 'Focus search' },
      { keys: ['Esc'], label: 'Close dialog / cancel' },
    ],
  },
  {
    group: 'Help',
    entries: [
      { keys: ['?'], label: 'Show this shortcuts list' },
    ],
  },
]

// A tiny event-bus so anything in the layout can request the
// dialog to open without prop drilling.
export const openShortcutsEvent = 'almyty:open-shortcuts'

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  // cmdk renders its input with role="combobox"; don't hijack while typing
  if (el.getAttribute('role') === 'combobox') return true
  return false
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isEditable(e.target)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    const openListener = () => setOpen(true)
    window.addEventListener(openShortcutsEvent, openListener)
    return () => {
      document.removeEventListener('keydown', handler)
      window.removeEventListener(openShortcutsEvent, openListener)
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="rounded border px-1.5 py-0.5 text-xs font-mono">?</kbd> anywhere to open this list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 pt-2">
          {shortcuts.map((group) => (
            <div key={group.group}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.group}
              </h3>
              <ul className="space-y-2">
                {group.entries.map((entry) => (
                  <li key={entry.label} className="flex items-center justify-between text-sm">
                    <span className="text-foreground">{entry.label}</span>
                    <span className="flex items-center gap-1">
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
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
