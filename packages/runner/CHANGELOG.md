# @almyty/runner

## 1.5.18

### Patch Changes

- @almyty/client@1.5.18

## 1.5.17

### Patch Changes

- @almyty/client@1.5.17

## 1.5.16

### Patch Changes

- @almyty/client@1.5.16

## 1.5.15

### Patch Changes

- f17166a: In a hosted pod, read the enrollment and model tokens from handed-over files in ALMYTY_HANDOVER_DIR and delete each once read, so no command run on the machine can find them in /proc/<pid>/environ.
- @almyty/client@1.5.15

## 1.5.14

### Patch Changes

- 9f66b3f: A runner no longer hangs when its connection to almyty opens but never answers. If the server, or a proxy in front of it, accepted the connection and sent nothing back, the runner waited forever and never reconnected. Now it gives up after 30 s without a response and reconnects with its usual backoff. A connection that is open and idle is left alone.
- @almyty/client@1.5.14

## 1.5.13

### Patch Changes

- 16f62e7: A runner keeps one connection to almyty and waits between reconnects. Each time the backend lost the runner's session, the runner started one more reconnect loop alongside the ones already running; over a day dozens ran at once, knocked each other's connections off, and retried so fast that the API rate-limited everything from the machine, sign-ins included. Now a reconnect while one is pending or connected does nothing, the logged delay is really waited (exponential with jitter, up to 30 s), a 429 waits its Retry-After and at least 30 s, the backoff restarts only after a connection stayed up, and a message delivered twice is handled once. A lost session no longer crashes the runner with "cannot open stream before any POST has assigned a session id".
- @almyty/client@1.5.13

## 1.5.12

### Patch Changes

- Updated dependencies [c2d6b20]
  - @almyty/client@1.5.12

## 1.5.11

### Patch Changes

- a4b8454: `almyty runner start` no longer hangs before it comes online when a tool on PATH is a version-manager shim (mise, asdf, pyenv) or checks for updates on `--version`. Each tool's version check now runs in its own process group, is stopped as a group when it times out, and no longer waits for leftover child processes to close its output. The runner also says how many tools it is checking and how long that took.
- @almyty/client@1.5.11

## 1.5.10

### Patch Changes

- 8877ce2: `almyty login` checks that the new key works in the organization you picked before saving it, and fails with a clear message if it does not. When `almyty runner start` is refused because the saved login belongs to another organization, it now says to run `almyty login` again and pick the organization.
- 94a9e07: Start coding sessions on macOS again: the runner makes node-pty's spawn-helper executable before its first terminal session, so Codex and Claude Code sessions, new or resumed, no longer fail with "posix_spawnp failed." A workspace folder not made yet is checked against `allowedCwdRoots` through its nearest existing parent, so a root under a symlink such as `/tmp` on macOS no longer refuses the runner's own workspace folders, and a new folder under a link that leads out of a root is refused.
- Updated dependencies [bf8ecc7]
  - @almyty/client@1.5.10

## 1.5.9

### Patch Changes

- 9411b31: Send coding output to the backend one POST at a time, in order, and retry a POST the backend could not record, so viewers see output in the order it was produced.
- @almyty/client@1.5.9
