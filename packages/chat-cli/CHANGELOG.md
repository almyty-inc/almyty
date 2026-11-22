# @almyty/chat

## 1.5.13

### Patch Changes

- @almyty/client@1.5.13

## 1.5.12

### Patch Changes

- c2d6b20: `almyty chat --json` names the model that answered and counts the steps. An agent on a fixed model printed `model: null`, and an answer given without a tool call printed `steps: 0`; the step count now comes from the finished run, and the model from the run's record when the live events did not name it.
- Updated dependencies [c2d6b20]
  - @almyty/client@1.5.12

## 1.5.11

### Patch Changes

- @almyty/client@1.5.11

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
