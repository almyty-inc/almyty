---
"@almyty/runner": patch
---

Start coding sessions on macOS again: the runner makes node-pty's spawn-helper executable before its first terminal session, so Codex and Claude Code sessions, new or resumed, no longer fail with "posix_spawnp failed." A workspace folder not made yet is checked against `allowedCwdRoots` through its nearest existing parent, so a root under a symlink such as `/tmp` on macOS no longer refuses the runner's own workspace folders, and a new folder under a link that leads out of a root is refused.