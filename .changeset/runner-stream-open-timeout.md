---
"@almyty/runner": patch
---

A runner no longer hangs when its connection to almyty opens but never answers. If the server, or a proxy in front of it, accepted the connection and sent nothing back, the runner waited forever and never reconnected. Now it gives up after 30 s without a response and reconnects with its usual backoff. A connection that is open and idle is left alone.
