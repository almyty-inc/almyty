# Full QA tour — 2026-06-03 staging

Browser-driven via vibesurfer against `app.staging.almyty.com`, signed in as `qa-tour-1780476584@almyty.test` (`QA Tour Org`). Findings recorded as they're found; severity is best-guess at discovery time.

## Auth flows (#118)

### L1 — Login form: silent submit on empty fields  (MEDIUM)

`pages/auth/login.tsx:143` — `disabled={isLoading || !isValid}` with RHF `mode: 'onTouched'`. Same pattern as the register form bug fixed in #151. Clicking "Sign in" with both fields empty triggers no validation errors and no notification — the button is disabled but visually still looks active (lavender). User has no feedback that the form is broken.

Fix: drop `!isValid` from the disabled prop. RHF's handleSubmit will trigger validation and inline errors will render via `errors.email.message` / `errors.password.message`.

