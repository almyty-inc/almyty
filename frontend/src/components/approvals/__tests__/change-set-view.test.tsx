import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../test/setup'
import { ChangeSetView, argumentsLine } from '../change-set-view'
import { decisionMessage, isChangeSet } from '@/pages/approvals'

/**
 * A script's change set in Approvals (code mode): every change listed with
 * what it does to data and any rule it trips, approved or rejected as a
 * whole, and a plain sentence on what each decision does.
 */
const entries = [
  { id: 1, toolId: 't', toolName: 'petstore_update_pet', codeName: 'petstore.updatePet', title: 'Update a pet', arguments: { id: 1, status: 'archived' }, sideEffect: 'write' as const, reason: 'policy' as const },
  { id: 2, toolId: 't2', toolName: 'petstore_delete_pet', codeName: 'petstore.deletePet', title: 'Delete a pet', arguments: { petId: 9 }, sideEffect: 'destructive' as const, reason: 'policy' as const, outcome: 'not_run' as const },
]

describe('a change set awaiting approval', () => {
  it('lists every change with what it does to data', () => {
    render(<ChangeSetView entries={entries} />)
    const list = screen.getByTestId('change-set')
    expect(list).toHaveTextContent('Update a pet')
    expect(list).toHaveTextContent('changes data')
    expect(list).toHaveTextContent('deletes data')
    expect(list).toHaveTextContent('petstore.deletePet(petId: 9)')
    expect(list).toHaveTextContent('did not run')
  })

  it('says what approving and rejecting the whole set does', () => {
    const row = { payload: { kind: 'change_set', changeSet: entries } }
    expect(isChangeSet(row)).toBe(true)
    expect(isChangeSet({ payload: { tool: 'issue_refund' } })).toBe(false)
    expect(decisionMessage(row, 'approve')).toMatch(/^All 2 changes run, in this order/)
    expect(decisionMessage(row, 'reject')).toMatch(/None of the changes run/)
    expect(decisionMessage({ payload: null }, 'reject')).toMatch(/cancelled for good/)
  })

  it('keeps an argument line short', () => {
    expect(argumentsLine({ note: 'x'.repeat(500) }, 40)).toHaveLength(40)
    expect(argumentsLine({})).toBe('no arguments')
  })

  it('is shown on the Approvals page (guard)', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'pages', 'approvals.tsx'), 'utf8')
    expect(source).toMatch(/isChangeSet\(row\) && \([\s\S]*<ChangeSetView entries=\{row\.payload!\.changeSet/)
    expect(source).toMatch(/\{decisionMessage\(row, decisionFor\.intent\)\}/)
  })
})
