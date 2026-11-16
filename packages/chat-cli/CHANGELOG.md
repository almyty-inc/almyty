# @almyty/chat

## 1.5.10

### Patch Changes

- 13ceefc: `almyty chat` reports a workflow agent's tokens and cost once. The pipeline's totals were added on top of the per-step figures they are the sum of, so every workflow answer showed twice what it used.
- bf8ecc7: `almyty chat <agent>` with a bare agent name works after `almyty login`: the organization comes from the one the login stored, not only from a JWT (`defaultOrganization` in `@almyty/client`). `@almyty/mcp-server` answers every request it has received before it exits when the client closes stdin, even while tool discovery is still running. `almyty credentials list` and `get` no longer print a credential's stored config, not even masked.
- 8ae8e40: `almyty agents inspect` and `run --watch` show the answer check: "no errors found" when it passes, with what that means (the answer's names, dates, versions, ids, counts and labels match what the tools returned; it can't confirm everything the answer says), or "errors found" and what was found. `almyty chat` says "the check found errors in the draft" when a check sends a draft back.
- Updated dependencies [bf8ecc7]
  - @almyty/client@1.5.10

## 1.5.9

### Patch Changes

- @almyty/client@1.5.9
