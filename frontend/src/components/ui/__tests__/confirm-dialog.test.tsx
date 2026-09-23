import { describe, it, expect } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'

import { useConfirm, type ConfirmOptions } from '../confirm-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogTitle,
} from '../alert-dialog'

function Harness({ options, onResult }: { options: ConfirmOptions; onResult: (v: boolean) => void }) {
  const { confirm, dialog } = useConfirm()
  return (
    <>
      <button onClick={async () => onResult(await confirm(options))}>Open</button>
      {dialog}
    </>
  )
}

const destructive: ConfirmOptions = {
  title: 'Delete this thing?',
  description: 'It cannot come back.',
  confirmLabel: 'Delete thing',
  destructive: true,
}

describe('useConfirm', () => {
  it('shows the title, description and labels it was given', async () => {
    const user = userEvent.setup()
    render(<Harness options={destructive} onResult={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Open' }))
    const dialog = await screen.findByRole('alertdialog')

    expect(within(dialog).getByText('Delete this thing?')).toBeInTheDocument()
    expect(within(dialog).getByText('It cannot come back.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Delete thing' })).toBeInTheDocument()
  })

  it('resolves true when confirmed and closes', async () => {
    const user = userEvent.setup()
    const results: boolean[] = []
    render(<Harness options={destructive} onResult={(v) => results.push(v)} />)

    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete thing' }))

    await waitFor(() => expect(results).toEqual([true]))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('resolves false when cancelled', async () => {
    const user = userEvent.setup()
    const results: boolean[] = []
    render(<Harness options={destructive} onResult={(v) => results.push(v)} />)

    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(results).toEqual([false]))
  })

  it('resolves false when dismissed with Escape', async () => {
    const user = userEvent.setup()
    const results: boolean[] = []
    render(<Harness options={destructive} onResult={(v) => results.push(v)} />)

    await user.click(screen.getByRole('button', { name: 'Open' }))
    await screen.findByRole('alertdialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(results).toEqual([false]))
  })

  it('styles the confirm button destructive only when asked to', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness options={destructive} onResult={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete thing' }),
    ).toHaveClass('bg-destructive')
    unmount()

    render(<Harness options={{ title: 'Rotate?', confirmLabel: 'Rotate' }} onResult={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const rotate = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rotate' })
    expect(rotate).toHaveClass('bg-primary')
    expect(rotate).not.toHaveClass('bg-destructive')
  })
})

describe('AlertDialogAction variant', () => {
  const renderAction = (props: React.ComponentProps<typeof AlertDialogAction>) =>
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Title</AlertDialogTitle>
          <AlertDialogAction {...props}>Go</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    )

  it('defaults to the primary button style', () => {
    renderAction({})
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button).toHaveClass('bg-primary')
    expect(button).not.toHaveClass('bg-destructive')
  })

  it('takes the destructive variant from buttonVariants', () => {
    renderAction({ variant: 'destructive' })
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button).toHaveClass('bg-destructive', 'text-destructive-foreground', 'hover:bg-destructive/90')
    expect(button).not.toHaveClass('bg-primary')
  })

  it('still merges a caller className', () => {
    renderAction({ variant: 'destructive', className: 'w-full' })
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('bg-destructive', 'w-full')
  })
})
