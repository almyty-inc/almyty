# Roles

**Status: BUILT** (2026-09-10). Layer 4 of `docs/design/layers.md`.
Depends on Models, and on Routing only when you ask it to.

A role is a named slot in an agent that some model fills.

## Why this exists

The model an agent used to live on each node. Moving an agent from a
hosted frontier model to your own fine-tune meant editing the graph node
by node, and doing it again for the next model. Every agent was quietly
tied to a vendor.

A role names the job. `principal`, `verifier`, `summariser`. The binding
says what fills it. Changing model is a binding change and the graph never
moves.

## A role

```json
{
  "key": "principal",
  "displayName": "Principal",
  "requirement": { "capabilities": { "tools": true }, "privacyTierCeiling": "private_cloud" },
  "binding": { "mode": "pinned", "modelId": "..." }
}
```

The **requirement** is what the job needs, and stays true when the binding
changes: a verifier needs tool use whether it is pinned or resolved.

The **binding** is what fills it, and is one of two things:

- `{ "mode": "pinned", "modelId": "..." }` names a model, always.
- `{ "mode": "resolved", "policy": { ... } }` asks Routing per run.

## A pinned role never touches the router

This is the rule that makes roles usable on their own. Routing can be
switched off entirely and an agent whose roles are all pinned still runs.

It is enforced by the type system rather than by care: the binding is a
discriminated union, so the code path that reaches the router cannot
compile for a pinned binding. Deleting the pinned branch does not
typecheck, because `policy` does not exist on the pinned variant.

Turning a filled role's model into something callable is a lookup, not a
plan. Asking the router to choose between one candidate would still be
routing.

## Nodes reference a role

An `llm_call` node carries `roleKey`. The run fills every role once and
the node reads the result rather than deciding again, so a run always
names the concrete model behind each role.

**The existing per-node `providerId` and `model` fields stay valid.**
Nothing that works today stops working; a node with no `roleKey` behaves
exactly as before. The per-node field is deprecated in this document only.

A node naming a role the agent does not define is refused, naming the role
and what to do about it, rather than falling back to something arbitrary.

## Per-run override

`resolveRoles(organizationId, agentId, { principal: "..." })` fills one
role differently for a single run without touching the agent. That is how
you try a model on a real task without committing to it.

## What a run records

Every resolved role is recorded with how it was chosen, `pinned` or
`resolved`, and the router's rationale when there was one. A run that
cannot say which model filled which role afterwards is not diagnosable.
