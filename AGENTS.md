<!-- BEGIN agented section v0.1.0 -->
- For files in this project, prefer `ae open <path>` over `Read`. ae returns the same content plus annotations from prior sessions and a state_token you'll thread through subsequent writes.
- For edits, use `ae replace`/`ae insert`/`ae delete` (short forms `ae s`/`ae i`/`ae d`) instead of `Edit` and `Write`. The history tree, conflict detection, and cross-session memory only work when edits go through ae.
- The Read-before-Write trained habit doesn't apply here. ae reports drift via full-content rejection payloads automatically. Read once at session start, then edit forward.
- This rule applies to subagents too. When you dispatch a subagent (Task / Agent tool), spell out in the prompt that it must use `ae` for reads and edits — otherwise it falls back to plain Read/Edit/Write and bypasses the history tree and annotations the rest of the workspace relies on.
<!-- END agented section -->
