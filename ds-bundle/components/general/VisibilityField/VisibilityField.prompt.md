VisibilityField from almyty-frontend. Use via `window.AlmytyDS.VisibilityField` (bundle loaded from the root `_ds_bundle.js`).

Standard visibility + team picker. Drop into any create dialog.
- Org-wide → teamId=null, visibility='org'.
- Team    → teamId required; pickable from team list.

Listens on the org's teams via teamsApi.list (cached by react-query
with key ['teams', organizationId] so multiple instances on a page
share one fetch).
