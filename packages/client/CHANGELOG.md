# @almyty/client

## 1.5.18

No changes in this release.

## 1.5.17

No changes in this release.

## 1.5.16

No changes in this release.

## 1.5.15

No changes in this release.

## 1.5.14

No changes in this release.

## 1.5.13

No changes in this release.

## 1.5.12

### Patch Changes

- c2d6b20: `almyty chat --json` names the model that answered and counts the steps. An agent on a fixed model printed `model: null`, and an answer given without a tool call printed `steps: 0`; the step count now comes from the finished run, and the model from the run's record when the live events did not name it.

## 1.5.11

No changes in this release.

## 1.5.10

### Patch Changes

- bf8ecc7: `almyty chat <agent>` with a bare agent name works after `almyty login`: the organization comes from the one the login stored, not only from a JWT (`defaultOrganization` in `@almyty/client`). `@almyty/mcp-server` answers every request it has received before it exits when the client closes stdin, even while tool discovery is still running. `almyty credentials list` and `get` no longer print a credential's stored config, not even masked.

## 1.5.9

No changes in this release.
