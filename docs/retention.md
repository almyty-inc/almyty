# Data retention

Every organization can say how long almyty keeps each class of
event data. One `retention_policies` row per org; each `*Days` field is a
number of days, and **null means keep forever**, which is the default for
every class. An org with no policy row is never swept.

Configured in the Data retention card under Settings → Organization, or over the API with `GET`/`PUT /organizations/:organizationId/retention`.

## The classes

| Field | Table | What it holds |
|---|---|---|
| `agentRunsDays` | `agent_runs` | Terminal runs only. A run still going is never deleted regardless of age. |
| `conversationsDays` | `conversations` + `messages` | A conversation, its messages and the files people sent in it (channel and web chat attachments, stored object included) go together. |
| `requestLogsDays` | `request_logs` | Scoped through the org's gateways. |
| `usageMetricsDays` | `usage_metrics` | Two rows per HTTP request, so this is the highest-count table. |
| `auditLogDays` | `audit_logs` | See the warning below. |
| `toolExecutionsDays` | `tool_executions` | The largest table by bytes: each row keeps `parameters` and `result` as untruncated json, and a tool may return up to 10MB. |
| `notificationsDays` | `notifications` | Written per failed scheduled or webhook run, and per approval request and decision. |

### Before you set `auditLogDays`

The audit log is the record you will be asked for. Deleting it on a
schedule is a decision to make deliberately, with whatever retention
obligation applies to you in mind — not a housekeeping setting. If you
need the history out of the product rather than gone, `audit_export`
(Business and above) pulls a full window as CSV or JSON, and can stream
to a SIEM.

## The two classes worth setting first

`tool_executions` grows fastest in bytes: a tool returning a 2MB payload
once a minute writes roughly 2.8GB a day, and nothing deletes it while the
field is null. `notifications` grows slowly but relentlessly — a
permanently broken five-minute schedule writes 288 rows a day, forever,
and schedules do break.

Like every other class, both default to null. Unlimited growth is the
default for all seven; these two are simply the ones where it costs the
most.

## Per-agent and per-channel retention

An agent can carry its own `privacy.retentionDays` in its visitor rules,
and a channel can override it; the sweep removes the conversations reaching
each channel through its gateway after the effective period, with the files sent in them. It never keeps
data **longer** than the organization policy — the shorter of the two
wins.

## Attachments that were never sent

A file a web chat or widget visitor uploads waits, with no conversation, for the message that names it; a channel attachment is stored before its run starts and filed under the run's conversation once it has one. An attachment that never reached a conversation (uploaded and not sent, or stored for a run that was refused) belongs to no policy, so it is removed deployment-wide a day after it was stored, on the same hourly tick. Erasing a web chat visitor or a widget thread removes that visitor's unsent uploads at once.

## Entity snapshots

`version` holds a full serialized copy of an entity on every update of a
`@VersionedEntity` — what the Change History panel reads. That table has
no `organizationId`, so no per-org policy can name it; it is pruned
deployment-wide at 90 days instead.

## How the sweep runs

Hourly, per organization, in batches, and it skips a policy with
`enabled: false`. Counts are written to the audit log as a
`retention_sweep` entry, and org owners and admins get one notification
per day when rows were deleted.
