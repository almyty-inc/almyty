/**
 * Picking values from earlier steps, the way a person thinks of them:
 * "Model call › Answer", not `{{nodes.llm_1.output}}`.
 *
 *   StepValueField   a text field where earlier values sit as chips among
 *                    the words; "Insert a value" adds one where the cursor is.
 *   StepValueSelect  one earlier value, picked from the same list (a tool
 *                    input, a condition's "if").
 *
 * The saved format is the template, unchanged, and nothing is written
 * until the person changes something. "Edit values as text" under a
 * step's Advanced shows the raw templates instead (StepTextMode).
 *
 * The list is the ModelPicker's combobox: a trigger, then a search box and
 * a grouped listbox opening inline under it.
 */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Node } from '@xyflow/react'
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { parseTemplate, refLabel, refTemplate, singleRef, type StepEntry } from './step-values'

/** Whether this step's values show as raw templates (Advanced › Edit values as text). */
export const StepTextMode = createContext<{ asText: boolean; setAsText: (next: boolean) => void }>({ asText: false, setAsText: () => {} })

/** The earlier steps a field can read from, and every node (to name a reference to a step not listed). */
export const StepCatalog = createContext<{ steps: StepEntry[]; nodes: Node[] }>({ steps: [], nodes: [] })

const CHIP_CLASS = 'mx-0.5 inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0 align-baseline text-xs font-medium text-primary'

// ─── The list of earlier values ──────────────────────────────────────────────

function StepValueList({ label, selected, onPick, onClose }: { label: string; selected?: string | null; onPick: (path: string) => void; onClose: () => void }) {
  const { steps } = useContext(StepCatalog)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    return steps
      .map((s) => ({ ...s, fields: s.fields.filter((f) => !q || f.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) }))
      .filter((s) => s.fields.length > 0)
  }, [steps, search])
  const flat = useMemo(() => groups.flatMap((g) => g.fields), [groups])

  useEffect(() => setActive(0), [search])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[active]
      if (item) onPick(item.path)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="rounded-md border bg-popover text-popover-foreground shadow-md" data-testid="step-value-list">
      <div className="flex items-center border-b px-2.5">
        <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search earlier steps"
          aria-controls={listId}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search earlier steps"
          className="h-9 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div id={listId} role="listbox" aria-label={label} className="max-h-60 overflow-y-auto p-1">
        {groups.length === 0 && <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">{steps.length === 0 ? 'No earlier steps yet. Wire one into this step first.' : 'Nothing matches.'}</p>}
        {groups.map((g) => (
          <div key={g.nodeId} role="group" aria-label={g.name} className="py-0.5">
            <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{g.name}</div>
            {g.fields.map((f) => {
              const idx = flat.indexOf(f)
              return (
                <div
                  key={f.path}
                  role="option"
                  aria-selected={selected === f.path}
                  aria-label={`${g.name} › ${f.label}`}
                  data-active={idx === active || undefined}
                  onMouseEnter={() => setActive(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(f.path)}
                  className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs', idx === active && 'bg-accent text-accent-foreground')}
                >
                  <Check className={cn('h-3.5 w-3.5 shrink-0', selected === f.path ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Close an open list when a click lands outside `root`. */
function useCloseOnOutside(open: boolean, setOpen: (v: boolean) => void) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as globalThis.Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, setOpen])
  return root
}

// ─── One earlier value ───────────────────────────────────────────────────────

export interface StepValueSelectProps {
  id: string
  label: string
  /** The stored template; a single reference shows as its name. */
  value: string
  onChange: (template: string) => void
  placeholder?: string
  hideLabel?: boolean
}

/** Pick one earlier value. Stores `{{path}}`; a value that is more than one reference falls back to the text field. */
export function StepValueSelect({ id, label, value, onChange, placeholder = 'Pick an earlier value', hideLabel }: StepValueSelectProps) {
  const { asText } = useContext(StepTextMode)
  const { steps, nodes } = useContext(StepCatalog)
  const [open, setOpen] = useState(false)
  const root = useCloseOnOutside(open, setOpen)
  const path = singleRef(value)

  if (asText || (value && !path)) {
    return <StepValueField id={id} label={label} value={value} onChange={onChange} hideLabel={hideLabel} />
  }

  return (
    <div className="space-y-1.5" ref={root}>
      <Label htmlFor={id} className={cn(hideLabel && 'sr-only')}>
        {label}
      </Label>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
      >
        <span className={cn('min-w-0 truncate', !path && 'text-muted-foreground')} data-testid={`${id}-value`}>
          {path ? refLabel(path, steps, nodes) : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
      </button>
      {open && (
        <StepValueList
          label={label}
          selected={path}
          onClose={() => setOpen(false)}
          onPick={(picked) => {
            setOpen(false)
            onChange(refTemplate(picked))
          }}
        />
      )}
    </div>
  )
}

// ─── Text with earlier values in it ──────────────────────────────────────────

export interface StepValueFieldProps {
  id: string
  label: string
  value: string
  onChange: (template: string) => void
  placeholder?: string
  multiline?: boolean
  hint?: React.ReactNode
  hideLabel?: boolean
}

/** Read the editor's DOM back into a template: text as typed, each chip as the reference it stands for. */
function serialize(root: HTMLElement): string {
  let out = ''
  const walk = (el: globalThis.Node, first: boolean) => {
    if (el.nodeType === 3) {
      out += (el.nodeValue ?? '').replace(/ /g, ' ')
      return
    }
    if (!(el instanceof HTMLElement)) return
    if (el.dataset.ref !== undefined) {
      out += el.dataset.ref
      return
    }
    if (el.tagName === 'BR') {
      out += '\n'
      return
    }
    // A browser wraps a new line in a <div> of its own.
    if ((el.tagName === 'DIV' || el.tagName === 'P') && !first) out += '\n'
    el.childNodes.forEach((child, i) => walk(child, i === 0))
  }
  root.childNodes.forEach((child, i) => walk(child, i === 0))
  return out
}

function chipNode(raw: string, label: string, onRemove: (chip: HTMLElement) => void): HTMLElement {
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.dataset.ref = raw
  chip.className = CHIP_CLASS
  chip.setAttribute('data-testid', 'step-value-chip')
  const text = document.createElement('span')
  text.textContent = label
  chip.appendChild(text)
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'ml-0.5 rounded-sm opacity-60 hover:opacity-100'
  remove.setAttribute('aria-label', `Remove ${label}`)
  remove.textContent = '×'
  remove.addEventListener('mousedown', (e) => e.preventDefault())
  remove.addEventListener('click', () => onRemove(chip))
  chip.appendChild(remove)
  return chip
}

/**
 * Text where earlier values appear as chips. Typing edits the words;
 * "Insert a value" drops a chip where the cursor was (or at the end); the
 * × on a chip takes it out. The stored template is rebuilt from what is on
 * screen, so a template nobody touched is never rewritten.
 */
export function StepValueField({ id, label, value, onChange, placeholder, multiline = false, hint, hideLabel }: StepValueFieldProps) {
  const { asText } = useContext(StepTextMode)
  const { steps, nodes } = useContext(StepCatalog)
  const editor = useRef<HTMLDivElement>(null)

  const lastRange = useRef<Range | null>(null)
  const [picking, setPicking] = useState(false)
  const pickerRoot = useCloseOnOutside(picking, setPicking)
  const labelsKey = useMemo(() => steps.map((s) => `${s.nodeId}:${s.name}:${s.fields.map((f) => f.label).join(',')}`).join('|'), [steps])
  // What the editor shows right now, as `${template}::${labels}`.
  const renderedFor = useRef<string | null>(null)
  // A chip's × is wired once, when the chip is drawn; these keep it writing
  // through the current props rather than the ones it was drawn with.
  const latest = useRef({ value, onChange, labelsKey })
  useLayoutEffect(() => {
    latest.current = { value, onChange, labelsKey }
  })

  const emit = () => {
    if (!editor.current) return
    const next = serialize(editor.current)
    renderedFor.current = `${next}::${latest.current.labelsKey}`
    if (next !== latest.current.value) latest.current.onChange(next)
  }

  const removeChip = (chip: HTMLElement) => {
    chip.remove()
    emit()
  }

  // Draw the value into the editor, unless it is what the editor itself just produced.
  useLayoutEffect(() => {
    const root = editor.current
    if (!root) return
    const key = `${value}::${labelsKey}`
    if (renderedFor.current === key) return
    const children: globalThis.Node[] = []
    for (const seg of parseTemplate(value || '')) {
      if (seg.kind === 'text') children.push(document.createTextNode(seg.text))
      else children.push(chipNode(seg.raw, refLabel(seg.path, steps, nodes), removeChip))
    }
    root.replaceChildren(...children)
    renderedFor.current = key
  })

  const rememberCaret = () => {
    const sel = window.getSelection?.()
    if (!sel || sel.rangeCount === 0 || !editor.current) return
    const range = sel.getRangeAt(0)
    if (editor.current.contains(range.startContainer)) lastRange.current = range.cloneRange()
  }

  const insert = (path: string) => {
    const root = editor.current
    if (!root) return
    const seg = { raw: refTemplate(path), label: refLabel(path, steps, nodes) }
    const chip = chipNode(seg.raw, seg.label, removeChip)
    const range = lastRange.current && root.contains(lastRange.current.startContainer) ? lastRange.current : null
    if (range) {
      range.deleteContents()
      range.insertNode(chip)
      range.setStartAfter(chip)
      range.collapse(true)
      lastRange.current = range
    } else {
      root.appendChild(chip)
    }
    emit()
  }

  const insertText = (text: string) => {
    const root = editor.current
    if (!root) return
    const sel = window.getSelection?.()
    const range = sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : null
    const node = document.createTextNode(text)
    if (range) {
      range.deleteContents()
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      sel!.removeAllRanges()
      sel!.addRange(range)
    } else {
      root.appendChild(node)
    }
    emit()
  }

  if (asText) {
    const TextControl = multiline ? Textarea : Input
    return (
      <div>
        <Label htmlFor={id} className={cn(hideLabel && 'sr-only')}>
          {label}
        </Label>
        <TextControl id={id} className="mt-1 font-mono text-xs" value={value} onChange={(e: any) => onChange(e.target.value)} {...(multiline ? { rows: 3 } : {})} />
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
    )
  }

  return (
    <div ref={pickerRoot}>
      <div className="flex items-center justify-between gap-2">
        <Label id={`${id}-label`} className={cn(hideLabel && 'sr-only')} onClick={() => editor.current?.focus()}>
          {label}
        </Label>
      </div>
      <div
        ref={editor}
        id={id}
        role="textbox"
        aria-labelledby={`${id}-label`}
        aria-multiline={multiline}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-testid={`${id}-editor`}
        onInput={emit}
        onKeyUp={rememberCaret}
        onMouseUp={rememberCaret}
        onBlur={rememberCaret}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !multiline) e.preventDefault()
          if (e.key === 'Enter' && multiline) {
            e.preventDefault()
            insertText('\n')
          }
        }}
        onPaste={(e) => {
          e.preventDefault()
          insertText(e.clipboardData.getData('text/plain'))
        }}
        className={cn(
          'mt-1 w-full whitespace-pre-wrap break-words rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30',
          'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
          multiline ? 'min-h-[4.5rem]' : 'min-h-9',
        )}
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : <span />}
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
          {picking ? <X className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
          Insert a value
        </Button>
      </div>
      {picking && (
        <StepValueList
          label={`Insert into ${label}`}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false)
            insert(path)
          }}
        />
      )}
    </div>
  )
}

