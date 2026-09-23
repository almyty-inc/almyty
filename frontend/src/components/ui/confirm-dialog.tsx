import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export interface ConfirmOptions {
  /** A sentence-case question, e.g. "Delete this team?" */
  title: React.ReactNode
  description?: React.ReactNode
  /** Sentence-case verb phrase, e.g. "Delete team" */
  confirmLabel: string
  cancelLabel?: string
  /** Style the confirm button as destructive. */
  destructive?: boolean
}

/**
 * Promise-based confirmation built on AlertDialog. Render `dialog` once in
 * the component, then `if (await confirm({...})) doTheThing()`.
 */
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  dialog: React.ReactNode
} {
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null)
  const [open, setOpen] = React.useState(false)
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null)

  const settle = React.useCallback((value: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOpen(false)
    resolve?.(value)
  }, [])

  const confirm = React.useCallback((opts: ConfirmOptions) => {
    // A second confirm while one is pending cancels the first.
    resolverRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setOptions(opts)
      setOpen(true)
    })
  }, [])

  // Never leave a caller awaiting forever if the component unmounts.
  React.useEffect(() => () => resolverRef.current?.(false), [])

  const dialog = (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description ? (
            <AlertDialogDescription>{options.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{options?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            variant={options?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {options?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { confirm, dialog }
}
