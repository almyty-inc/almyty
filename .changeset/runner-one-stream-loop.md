---
"@almyty/runner": patch
---

A runner keeps one connection to almyty and waits between reconnects. Each time the backend lost the runner's session, the runner started one more reconnect loop alongside the ones already running; over a day dozens ran at once, knocked each other's connections off, and retried so fast that the API rate-limited everything from the machine, sign-ins included. Now a reconnect while one is pending or connected does nothing, the logged delay is really waited (exponential with jitter, up to 30 s), a 429 waits its Retry-After and at least 30 s, the backoff restarts only after a connection stayed up, and a message delivered twice is handled once. A lost session no longer crashes the runner with "cannot open stream before any POST has assigned a session id".
