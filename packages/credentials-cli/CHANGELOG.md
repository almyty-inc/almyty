# @almyty/credentials

## 1.5.10

### Patch Changes

- bf8ecc7: `almyty chat <agent>` with a bare agent name works after `almyty login`: the organization comes from the one the login stored, not only from a JWT (`defaultOrganization` in `@almyty/client`). `@almyty/mcp-server` answers every request it has received before it exits when the client closes stdin, even while tool discovery is still running. `almyty credentials list` and `get` no longer print a credential's stored config, not even masked.
- Updated dependencies [bf8ecc7]
  - @almyty/client@1.5.10

## 1.5.9

### Patch Changes

- @almyty/client@1.5.9
