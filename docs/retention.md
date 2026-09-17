# Data retention

Every organization can say how long almyty keeps each class of
event data. One `retention_policies` row per org; each `*Days` field is a
number of days, and **null means keep forever**, which is the default for
every class. An org with no policy row is never swept.

Configured under Settings → Data Retention, or
`PUT /retention/:organizationId`.

## The classes

| Field | Table | What it holds |
|---|---|---|
| `agentRunsDays` | `agent_runs` | Terminal runs only. A run still going is never deleted regardless of age. |
| `conversationsDays` | `conversations` + `messages` | A conversation and its messages go together. |
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

## Why the two newest classes matter

`tool_executions` and `notifications` were the only per-event tables with
no sweep at all while every sibling had one, so they grew for the life of
the deployment.

`tool_executions` grows fastest in bytes: a tool returning a 2MB payload
once a minute writes roughly 2.8GB a day that nothing deleted.
`notifications` grows slowly but relentlessly — a permanently broken
five-minute schedule writes 288 rows a day, forever, and schedules do
break.

Both default to null, so nothing changes for an existing install until
somebody sets a window.

## Per-app retention

An app under `/apps` can carry its own `privacy.retentionDays`, which
sweeps the conversations reaching it through its gateways. It never keeps
data **longer** than the organization policy — the shorter of the two
wins.

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
