/* Pages for the Memory area's create flows. The forms live in
 * components/memory/. */
import { useEffect } from 'react'

import { AddMemoryForm } from '@/components/memory/add-memory-form'
import { TransferMemoryForm } from '@/components/memory/transfer-memory-form'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

export function MemoryNewPage() {
  useTitle('Add memory')
  return <AddMemoryForm />
}

export function MemoryTransferPage() {
  useTitle('Transfer memory')
  return <TransferMemoryForm />
}
