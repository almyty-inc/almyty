// The fixed task set of the tool-mode benchmark. Each task is checked on
// the end state of the mock APIs and on the answer, never by a model:
// `check` gets the state after the run, the state it started from, the
// final answer and the log of API calls, and says pass or fail and why.
//
// `reference` is what a correct run does, applied straight to the state,
// with the answer it would give: the self-check (run.mjs --self-check)
// proves every check passes on it and fails on a run that does nothing.

const has = (text, ...needles) => needles.every((n) => String(text ?? '').toLowerCase().includes(String(n).toLowerCase()))
const writes = (calls) => calls.filter((c) => c.method !== 'get')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const result = (ok, why) => ({ ok, why })
const REFUSAL = /\b(can(no|')t|cannot|unable|not able|no (tool|way|api)|don'?t have|do not have|not possible|isn'?t possible|not supported)\b/i

/** Nothing written, and an answer that says it cannot be done. */
const impossible = ({ calls, output }) => {
  if (writes(calls).length) return result(false, `wrote: ${writes(calls).map((c) => c.operationId).join(', ')}`)
  return REFUSAL.test(output ?? '') ? result(true, 'declined, nothing written') : result(false, 'did not say it cannot be done')
}

export const TASKS = [
  // ── Single lookups ────────────────────────────────────────────────────
  {
    id: 'lookup-pet-name',
    kind: 'lookup',
    prompt: 'What is the name of the pet with id 7?',
    check: ({ output, calls }) => result(has(output, 'Captain Whiskers') && !writes(calls).length, 'answer names Captain Whiskers, nothing written'),
    reference: () => 'Pet 7 is Captain Whiskers.',
  },
  {
    id: 'lookup-stock',
    kind: 'lookup',
    prompt: 'How many units of SKU-COFFEE are in stock in the coffee shop?',
    check: ({ output, calls }) => result(/\b37\b/.test(output ?? '') && !writes(calls).length, 'answer says 37, nothing written'),
    reference: () => 'There are 37 units of SKU-COFFEE in stock.',
  },
  {
    id: 'lookup-ticket-status',
    kind: 'lookup',
    prompt: 'What is the status of helpdesk ticket T-1004?',
    check: ({ output, calls }) => result(has(output, 'pending') && !writes(calls).length, 'answer says pending, nothing written'),
    reference: () => 'Ticket T-1004 is pending.',
  },

  // ── Multi-step reads ──────────────────────────────────────────────────
  {
    id: 'read-order-customer-email',
    kind: 'multi-read',
    prompt: 'Who placed coffee shop order O-2003, and what is their email address?',
    check: ({ output, calls }) => result(has(output, 'dmitri.volkov@example.com') && !writes(calls).length, 'answer has the customer email'),
    reference: () => 'Order O-2003 was placed by Dmitri Volkov (dmitri.volkov@example.com).',
  },
  {
    id: 'read-sold-pets',
    kind: 'multi-read',
    prompt: 'Which pets in the pet store are sold? Give their names.',
    check: ({ output, calls }) => result(has(output, 'Mochi', 'Rocket', 'Nibbles') && !has(output, 'Biscuit') && !writes(calls).length, 'names the three sold pets and no other'),
    reference: () => 'The sold pets are Mochi, Rocket and Nibbles.',
  },
  {
    id: 'read-dana-open-tickets',
    kind: 'multi-read',
    prompt: 'Which open helpdesk tickets are assigned to Dana? Give the ticket ids.',
    check: ({ output, calls }) =>
      result(has(output, 'T-1001', 'T-1006') && !has(output, 'T-1004') && !writes(calls).length, 'T-1001 and T-1006, not the pending T-1004'),
    reference: () => 'Dana has two open tickets: T-1001 and T-1006.',
  },

  // ── Writes ────────────────────────────────────────────────────────────
  {
    id: 'write-mark-sold',
    kind: 'write',
    prompt: 'Mark pet 3 as sold in the pet store.',
    check: ({ state, seed }) => {
      const pet = state.pets.find((p) => p.id === 3)
      const others = state.pets.filter((p) => p.id !== 3)
      return result(pet?.status === 'sold' && same(others, seed.pets.filter((p) => p.id !== 3)), 'pet 3 sold, every other pet unchanged')
    },
    reference: (state) => { state.pets.find((p) => p.id === 3).status = 'sold'; return 'Pet 3 is now sold.' },
  },
  {
    id: 'bulk-close-spam',
    kind: 'bulk-write',
    prompt: 'Close every helpdesk ticket tagged spam. Leave all other tickets as they are.',
    check: ({ state, seed }) => {
      const spam = state.tickets.filter((t) => t.tags.includes('spam'))
      const rest = state.tickets.filter((t) => !t.tags.includes('spam'))
      const ok = spam.length === 3 && spam.every((t) => t.status === 'closed') && same(rest, seed.tickets.filter((t) => !t.tags.includes('spam')))
      return result(ok, 'T-1002, T-1005, T-1008 closed and still there; no other ticket changed')
    },
    reference: (state) => { for (const t of state.tickets) if (t.tags.includes('spam')) t.status = 'closed'; return 'Closed T-1002, T-1005 and T-1008.' },
  },
  {
    id: 'bulk-cancel-pending',
    kind: 'bulk-write',
    prompt: "Cancel all of Chiara Rossi's pending orders in the coffee shop.",
    check: ({ state, seed }) => {
      const want = (o) => (o.customerId === 'C-12' && o.status === 'pending' ? { ...o, status: 'cancelled' } : o)
      return result(same(state.orders, seed.orders.map(want)), 'O-2002 and O-2004 cancelled, O-2005 and other orders unchanged')
    },
    reference: (state) => { for (const o of state.orders) if (o.customerId === 'C-12' && o.status === 'pending') o.status = 'cancelled'; return 'Cancelled O-2002 and O-2004.' },
  },
  {
    id: 'bulk-restock',
    kind: 'bulk-write',
    prompt: 'In the coffee shop, set the stock of every product with fewer than 5 units to 20 units. Do not change any other product.',
    check: ({ state, seed }) => {
      const want = seed.products.map((p) => (p.stock < 5 ? { ...p, stock: 20 } : p))
      return result(same(state.products, want), 'SKU-MUG, SKU-FILTER, SKU-GRINDER at 20; the rest unchanged')
    },
    reference: (state) => { for (const p of state.products) if (p.stock < 5) p.stock = 20; return 'Restocked SKU-MUG, SKU-FILTER and SKU-GRINDER to 20.' },
  },

  // ── Tasks no tool can do ──────────────────────────────────────────────
  {
    id: 'impossible-flight',
    kind: 'impossible',
    prompt: 'Book me a flight to Lisbon for next Tuesday.',
    check: impossible,
    reference: () => "I can't book flights: none of my tools can do that.",
  },
  {
    id: 'impossible-sms',
    kind: 'impossible',
    prompt: 'Send a text message to the customer of coffee shop order O-2001 saying their parcel is late.',
    check: impossible,
    reference: () => 'I cannot send text messages; no tool I have does that.',
  },
]
