import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { act, screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '../alert-dialog'

// Regression for #127: the Dialog + AlertDialog primitives carried
// data-[state=closed]:animate-out classes. Radix Presence waits for
// the animationend event before unmounting the Portal — on staging
// the event never fired, so dialogs got stuck on screen with
// data-state="closed" forever. Dropping the exit animation classes
// makes Radix unmount synchronously.

function ControlledDialog() {
  const [open, setOpen] = useState(true)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>my dialog</DialogTitle>
        </DialogHeader>
        <button onClick={() => setOpen(false)}>close-inside</button>
      </DialogContent>
    </Dialog>
  )
}

function ControlledAlertDialog() {
  const [open, setOpen] = useState(true)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogTitle>my alert</AlertDialogTitle>
        <button onClick={() => setOpen(false)}>close-inside</button>
      </AlertDialogContent>
    </AlertDialog>
  )
}

describe('Dialog / AlertDialog close behavior', () => {
  it('Dialog content has no data-[state=closed] animation classes', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>x</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const content = document.querySelector('[role="dialog"]') as HTMLElement
    expect(content).not.toBeNull()
    expect(content.className).not.toContain('data-[state=closed]:animate-out')
    expect(content.className).not.toContain('data-[state=closed]:fade-out')
    expect(content.className).not.toContain('data-[state=closed]:zoom-out')
    expect(content.className).not.toContain('data-[state=closed]:slide-out')
  })

  it('AlertDialog content has no data-[state=closed] animation classes', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>x</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    )
    const content = document.querySelector('[role="alertdialog"]') as HTMLElement
    expect(content).not.toBeNull()
    expect(content.className).not.toContain('data-[state=closed]:animate-out')
    expect(content.className).not.toContain('data-[state=closed]:fade-out')
    expect(content.className).not.toContain('data-[state=closed]:zoom-out')
    expect(content.className).not.toContain('data-[state=closed]:slide-out')
  })

  it('Dialog unmounts the Portal content when controlled open flips to false', async () => {
    render(<ControlledDialog />)
    expect(screen.getByText('my dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByText('close-inside'))

    await waitFor(() => {
      expect(screen.queryByText('my dialog')).not.toBeInTheDocument()
    })
  })

  it('AlertDialog unmounts the Portal content when controlled open flips to false', async () => {
    render(<ControlledAlertDialog />)
    expect(screen.getByText('my alert')).toBeInTheDocument()

    fireEvent.click(screen.getByText('close-inside'))

    await waitFor(() => {
      expect(screen.queryByText('my alert')).not.toBeInTheDocument()
    })
  })
})
