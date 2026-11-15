---
"@almyty/agents": patch
"@almyty/chat": patch
---

`almyty agents inspect` and `run --watch` show the answer check: "no errors found" when it passes, with what that means (the answer's names, dates, versions, ids, counts and labels match what the tools returned; it can't confirm everything the answer says), or "errors found" and what was found. `almyty chat` says "the check found errors in the draft" when a check sends a draft back.
