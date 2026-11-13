# @almyty/mcp-server

## 1.5.10

### Patch Changes

- bf8ecc7: `almyty chat <agent>` with a bare agent name works after `almyty login`: the organization comes from the one the login stored, not only from a JWT (`defaultOrganization` in `@almyty/client`). `@almyty/mcp-server` answers every request it has received before it exits when the client closes stdin, even while tool discovery is still running. `almyty credentials list` and `get` no longer print a credential's stored config, not even masked.
- 0572dcc: `almyty_execute` now reports a failed call as an error: when the tool's upstream API refuses it (a 401 from Stripe, say) the result carries `isError: true` with the error text, as the gateway's own tools do, instead of coming back as ordinary data. `almyty_search` now searches by words rather than for the whole query as one string: common words are ignored and the remaining ones are matched across each tool's name, title and description, best match first, so a phrase like "get an issue" finds `get_issue`.
- Updated dependencies [bf8ecc7]
  - @almyty/client@1.5.10

## 1.5.9

### Patch Changes

- @almyty/client@1.5.9
