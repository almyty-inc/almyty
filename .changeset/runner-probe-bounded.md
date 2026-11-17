---
"@almyty/runner": patch
---

`almyty runner start` no longer hangs before it comes online when a tool on PATH is a version-manager shim (mise, asdf, pyenv) or checks for updates on `--version`. Each tool's version check now runs in its own process group, is stopped as a group when it times out, and no longer waits for leftover child processes to close its output. The runner also says how many tools it is checking and how long that took.
