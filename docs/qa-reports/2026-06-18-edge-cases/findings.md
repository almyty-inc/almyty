# Edge-case QA — staging, 2026-06-18

Browser-driven via vibesurfer against `app.staging.almyty.com`, signed in
as `qa-tour-1780476584@almyty.test` (`QA Tour Org`). Edge cases run
form-by-form. Severity is best-guess at discovery.

## T2 — Create Tool: missing client-side `maxLength` on name  (MEDIUM)

Submitting an oversize name (300 chars) reaches the backend, which
correctly rejects with:

```
HTTP 400
{"error":{"code":"BAD_REQUEST",
          "message":"name must be shorter than or equal to 100 characters",
          "statusCode":400,
          "path":"/organizations/.../tools"}}
```

Frontend has no inline validation for `name` length, so users hit the
wire before learning the rule. Add a Zod `.max(100)` to the create-tool
schema mirroring the DTO (`tools/dto/create-tool.dto.ts`'s
`@MaxLength(100)`).

## T3 — Create Tool: dialog stuck on "Creating..." after 400  (HIGH)

After the 400 above, the submit button stays in its `isPending` state
indefinitely (`btn "Creating..."`), the `Notifications` region is
empty (no toast surfaced), and the dialog cannot be re-submitted
without manually closing it.

Console log confirms the rejection reached the axios interceptor:
```
API Error: {"url":"/organizations/.../tools","status":400,
            "code":"ERR_BAD_REQUEST","retries":"0"}
```

`createToolMutation`'s `onError` (`pages/tools.tsx:381`) calls
`notifications.error(...)`. Either the toast component is silently
dropping the call, or the mutation is in some non-settled state.
Likely culprit: the error normalization. The backend wraps
errors as `{ error: { message } }` but the handler reads
`error.response?.data?.message` — that path is `undefined`, the
toast falls back to a generic message, and maybe a thrown
`undefined` somewhere up the stack derails the React commit.

Repro:
1. Open Tools → Create Tool
2. Fill name with 300 chars (`'a' * 300`)
3. Fill URL with `https://example.com/test`
4. Submit
5. Observe: button stays "Creating..." 30+ s, no toast

Screenshot: `T3-create-tool-stuck-creating.png`

Fix:
- Surface `error.response?.data?.error?.message` (the actual backend
  shape) in `tools.tsx:382`.
- Audit every `*Mutation` `onError` for the same path-mismatch — it
  was introduced when the backend switched to the wrapped error
  shape but the frontend handlers weren't all updated.

## T4 — Create Tool: stale form + stuck mutation across dialog close/reopen  (HIGH)

After T3 (stuck "Creating..."), clicking Cancel + reopening Create Tool
shows the previous attempt's payload preloaded (300-char name, prior
URL) AND the button still reads "Creating...". The mutation never
settled even after navigating away from the dialog, so isPending is
permanently true. The dialog is functionally bricked until the
underlying React Query mutation cache is reset.

Screenshot: `T4-stale-form-state.png`

Two distinct bugs underneath:
- `createForm` is not `reset()`-ed on Dialog open or close.
- `createToolMutation` returns to an unreachable state after a 400
  error if the `onError` toast write throws (likely the cause — see T3).

Fix:
- Add `onOpenChange={(open) => { if (open) createForm.reset() }}`
  on the dialog (or move the form to the dialog's mount cycle).
- Add `mutation.reset()` to the dialog's effect cleanup, or use
  `useMutation({...,onSettled: () => {}})` to guarantee settle.
