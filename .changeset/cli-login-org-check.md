---
"@almyty/auth": patch
"@almyty/runner": patch
---

`almyty login` checks that the new key works in the organization you picked before saving it, and fails with a clear message if it does not. When `almyty runner start` is refused because the saved login belongs to another organization, it now says to run `almyty login` again and pick the organization.
