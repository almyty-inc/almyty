/**
 * Copy seen on staging that read like code: the Approvals empty state
 * named the `request_approval` tool, and the members list showed stored
 * role values ("owner") next to team pickers that say "Member".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { roleLabel } from '@/components/MembersAndTeamsTab'

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('people words, not code', () => {
  it('explains approvals without naming an internal tool', () => {
    const page = src('pages/approvals.tsx')
    expect(page).not.toContain('request_approval')
    expect(page).toContain('When an agent stops to ask a person before it goes on')
  })

  it('shows roles in sentence case', () => {
    expect(roleLabel('owner')).toBe('Owner')
    expect(roleLabel('ADMIN')).toBe('Admin')
    expect(roleLabel(undefined)).toBe('')
    const tab = src('components/MembersAndTeamsTab.tsx')
    expect(tab).toContain('{roleLabel(member.role)}')
    expect(tab).toContain('{roleLabel(invite.role)}')
    expect(tab).not.toMatch(/>expired</)
  })
})
