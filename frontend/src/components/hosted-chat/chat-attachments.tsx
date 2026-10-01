import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Paperclip, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { pluralized } from '@/lib/utils'
import {
  HOSTED_CHAT_ATTACHMENT_ACCEPT,
  HOSTED_CHAT_MAX_ATTACHMENTS,
  HOSTED_CHAT_MAX_ATTACHMENT_BYTES,
  type HostedChatAttachment,
} from '@/lib/hosted-chat'

/** A file the visitor picked: uploading, ready to send (with its id), or refused. */
export interface PendingAttachment {
  key: string
  name: string
  status: 'uploading' | 'ready' | 'failed'
  id?: string
  error?: string
}

let nextKey = 0

/**
 * The files a visitor attaches to their next message.
 *
 * Each file is uploaded as soon as it is picked, so sending does not wait
 * on it; the message then names the uploads by id. The surface decides
 * what it takes (images, PDFs, text files, up to 10 MB, five per message)
 * and says so when it refuses one; the size and count are checked here too
 * so the visitor is told before a pointless upload.
 */
export function useChatAttachments(upload: (file: File) => Promise<HostedChatAttachment>) {
  const [items, setItems] = useState<PendingAttachment[]>([])

  const patch = useCallback((key: string, next: Partial<PendingAttachment>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...next } : item)))
  }, [])

  // What is on screen, for `add` to count against without a state updater
  // that starts uploads (an updater may run twice).
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const add = useCallback(
    (files: FileList | File[]) => {
      let room = HOSTED_CHAT_MAX_ATTACHMENTS - itemsRef.current.filter((item) => item.status !== 'failed').length
      const added: PendingAttachment[] = []
      const uploads: Array<[string, File]> = []
      for (const file of Array.from(files)) {
        const key = `att-${++nextKey}`
        if (room <= 0) {
          added.push({ key, name: file.name, status: 'failed', error: `Up to ${pluralized(HOSTED_CHAT_MAX_ATTACHMENTS, 'file')} per message` })
        } else if (file.size > HOSTED_CHAT_MAX_ATTACHMENT_BYTES) {
          added.push({ key, name: file.name, status: 'failed', error: 'Larger than 10 MB' })
        } else {
          room -= 1
          added.push({ key, name: file.name, status: 'uploading' })
          uploads.push([key, file])
        }
      }
      setItems((current) => [...current, ...added])
      for (const [key, file] of uploads) {
        upload(file)
          .then((stored) => patch(key, { status: 'ready', id: stored.id }))
          .catch((err) => patch(key, { status: 'failed', error: getApiErrorMessage(err, 'Could not be uploaded') }))
      }
    },
    [patch, upload],
  )

  const remove = useCallback((key: string) => setItems((current) => current.filter((item) => item.key !== key)), [])
  const clear = useCallback(() => setItems([]), [])

  const ready = useMemo(() => items.filter((item) => item.status === 'ready' && item.id), [items])
  return {
    items,
    add,
    remove,
    clear,
    readyIds: ready.map((item) => item.id!) as string[],
    readyNames: ready.map((item) => item.name),
    uploading: items.some((item) => item.status === 'uploading'),
    full: items.filter((item) => item.status !== 'failed').length >= HOSTED_CHAT_MAX_ATTACHMENTS,
  }
}

/** The paperclip: opens the file picker, and hands what was picked over. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground"
      >
        <Paperclip className="h-4 w-4" />
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={HOSTED_CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        data-testid="attachment-input"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files)
          // The same file can be picked again after it is removed.
          e.target.value = ''
        }}
      />
    </>
  )
}

/** The picked files above the composer: name, state, and a way to take one back. */
export function AttachmentChips({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null
  return (
    <ul className="flex flex-wrap gap-2 px-1 pb-2" aria-label="Attached files">
      {items.map((item) => (
        <li
          key={item.key}
          className={
            item.status === 'failed'
              ? 'flex max-w-full items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive'
              : 'flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 px-2 py-1 text-xs'
          }
        >
          {item.status === 'uploading' && <LoadingSpinner className="h-3 w-3" />}
          {item.status === 'failed' && <AlertCircle className="h-3 w-3 shrink-0" />}
          <span className="max-w-[12rem] truncate">{item.name}</span>
          {item.error && <span className="truncate">: {item.error}</span>}
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.key)}
            className="ml-0.5 rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}
