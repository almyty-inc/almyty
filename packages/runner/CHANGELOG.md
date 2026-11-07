# @almyty/runner

## 1.5.10

### Patch Changes

- 94a9e07: Start coding sessions on macOS again: the runner makes node-pty's spawn-helper executable before its first terminal session, so Codex and Claude Code sessions, new or resumed, no longer fail with "posix_spawnp failed." A workspace folder not made yet is checked against `allowedCwdRoots` through its nearest existing parent, so a root under a symlink such as `/tmp` on macOS no longer refuses the runner's own workspace folders, and a new folder under a link that leads out of a root is refused.
- @almyty/client@1.5.10

## 1.5.9

### Patch Changes

- 9411b31: Send coding output to the backend one POST at a time, in order, and retry a POST the backend could not record, so viewers see output in the order it was produced.
- @almyty/client@1.5.9
