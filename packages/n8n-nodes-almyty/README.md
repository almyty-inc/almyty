# n8n-nodes-almyty

Run an almyty agent from an n8n workflow. n8n builds the workflow; almyty is
the agent underneath. A step in your workflow hands the agent a task, the
agent does the work with its own tools and models, and the next step gets
its answer.

## Install

In n8n, open **Settings → Community nodes**, choose **Install**, and enter:

```
n8n-nodes-almyty
```

Self-hosted n8n without the settings page can install it from the n8n user
folder instead:

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-almyty
```

Restart n8n afterwards. The node shows up as **almyty** in the node panel.

## Credentials

Create an **almyty API** credential:

| Field    | What to put in it |
|----------|-------------------|
| Base URL | `https://api.almyty.com`. Change it only if you run almyty yourself, then use your own API address. |
| API Key  | An API key from almyty: **Settings → API keys → Create**. The key works in the organization it was created in, so create it in the organization whose agents you want to run. |
| App URL  | Optional. Where people open almyty in the browser, used for links to runs. Left empty, it is worked out from the base URL (`api.almyty.com` becomes `app.almyty.com`). |

n8n checks the key when you save the credential by listing your agents.

## Usage

The node has one action, **Run agent**.

| Field           | What it does |
|-----------------|--------------|
| Agent           | The agent to run, picked from your organization's agents. |
| Input           | What you ask the agent to do. Use an expression to pass data from earlier steps. |
| Wait for result | On (the default): wait for the agent's answer. Off: start the agent and carry on straight away. |
| Max wait        | How long to wait for the answer, in seconds (default 300). Shown when Wait for result is on. |

### What comes out

**Finished:**

```json
{
  "runId": "38561140-581b-4024-936b-8feec08ba9c7",
  "status": "completed",
  "output": "The capital of Croatia is Zagreb.",
  "cost": 0.001438,
  "durationMs": 764
}
```

`cost` is in US dollars and `durationMs` in milliseconds. Either is `null`
when almyty did not record it.

**Wait for result off:** the run ID and status only, for example
`{ "runId": "…", "status": "running" }`. Look the run up in almyty later.

**Waiting for someone:** when the agent stops to ask for an approval or for
more input, the step does not fail. You get the status
(`waiting_approval` or `waiting_input`), the run ID, and `runUrl`, a link to
the run in almyty where someone can approve or answer.

**Still working when the max wait runs out:** you get the run ID, the status
`running`, and `runUrl`. `runStatus` says what the run was doing at that
moment (`running`, or `sleeping` while, say, its hosted machine starts). The
agent keeps working in almyty.

**Failed:** the step fails with the run's own error message. With n8n's
**On Error → Continue** setting, the item goes on instead, carrying
`status`, `error`, `runId` and `runUrl`.

### Workflow agents and autonomous agents

An autonomous agent gets your input as its task. A workflow agent gets it as
`input.message`, which its steps read as `{{input.message}}`. A workflow
agent answers in one request, so its result comes back whole even with Wait
for result off.

## Development

```bash
npm ci
npm run build   # dist/
npm run lint    # n8n's community node rules
npm test
```

To try it in a local n8n, link the package into `~/.n8n/custom`:

```bash
npm run build
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom
npm link /path/to/almyty/packages/n8n-nodes-almyty
```
