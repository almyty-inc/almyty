---
"@almyty/client": patch
"@almyty/chat": patch
"@almyty/mcp-server": patch
"@almyty/credentials": patch
---

`almyty chat <agent>` with a bare agent name works after `almyty login`: the organization comes from the one the login stored, not only from a JWT (`defaultOrganization` in `@almyty/client`). `@almyty/mcp-server` answers every request it has received before it exits when the client closes stdin, even while tool discovery is still running. `almyty credentials list` and `get` no longer print a credential's stored config, not even masked.
