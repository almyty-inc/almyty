# Agent invocation error feedback — 2026-09-09

## Reproduction

Tested with VibeSurfer on `https://app.staging.almyty.com`, signed in as Ava in the Northwind AI QA organization. Created the disposable workflow **QA Draft Invoke Error 20260909**, saved it as a draft without activating it, then opened **Test** and clicked **Run**.

The backend correctly refuses to invoke a draft. The builder displayed only `Error: Request failed with status code 400`. The output text was absent from the browser accessibility snapshot; a screenshot showed that the screen was not actually blank.

![Generic HTTP error before the fix](draft-invoke-error-before.png)

## Cause and fix

`GlobalExceptionFilter` returns `{ error: { code, message, statusCode, ... } }`. The header Invoke dialog, builder Test panel, and Overview Try It were reading the older `response.data.message` location. They now use the existing `getApiErrorMessage` helper and render the backend reason in an accessible alert. A retry clears old errors; a new Invoke attempt also clears a stale successful result.

The activation requirement is unchanged. This fix does not activate agents or run draft workflows.

## Verification

- Focused component/helper tests: 10 passed. Coverage includes all three surfaces, exact wrapped backend text, local invalid JSON, retry recovery, and clearing stale results.
- Full frontend suite: 90 files / 675 tests passed. Frontend TypeScript and production build passed.
- Promotion CI backend run: 339 suites / 6,178 tests passed; 4 suites / 23 tests skipped. Backend typecheck and backend/frontend/docs dependency audits passed. [CI evidence](https://github.com/almyty-inc/almyty/actions/runs/34346736763).
- Live pre-fix staging reproduction captured above; all three post-deploy checks passed as detailed below.

The disposable draft remains unactivated; neither existing active agent was modified.

## Release

Implementation [PR #588](https://github.com/almyty-inc/almyty/pull/588) merged into development. Staging promotion [PR #589](https://github.com/almyty-inc/almyty/pull/589) merged at `1db679d3fa1c48f1db5b0168ea3ec7b7ee8e11df`, together with chat documentation #587 and the isolated Multer security patch #590. Models-layer PR #586 was not part of #589.

The staging push build appeared late and superseded a manually dispatched build for the same commit. That run was subsequently superseded during the implementing team's further promotions. Final verification used the deployed staging revision `4f937e178b01db28139da7d3be0e687c8428ad32` (promotion #593, including the models and boot fixes), not the incomplete original build. [Image build](https://github.com/almyty-inc/almyty/actions/runs/34362716624) and [staging rollout](https://github.com/almyty-inc/infra/actions/runs/34363543540) succeeded; API and frontend rolled out and smoke checks passed.

## Live post-deploy check

VibeSurfer browser checks on September 9, approximately 16:34–16:37 UTC, after reloading staging and confirming Ava / Northwind AI:

| Surface | Result |
|---|---|
| Header Invoke dialog | Exact inline reason: `Agent must be active to invoke` |
| Overview Try It | Same reason; typed message preserved |
| Builder Test panel | `Error: Agent must be active to invoke` in Output |
| Agent state | Still Draft; never activated during QA |

The VibeSurfer tree still omitted the plain error text, so screenshots were used for visual verification. Component tests verify `role="alert"`; the browser snapshot alone is not treated as a screen-reader test.

- [Invoke dialog after deployment](draft-invoke-dialog-after.png)
- [Overview after deployment](draft-invoke-overview-after.png)
- [Builder after deployment](draft-invoke-builder-after.png)
