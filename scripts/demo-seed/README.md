# Demo seed and screenshot walks

The docs screenshots (`docs-site/public/screenshots`, tracked in its
`manifest.json`) are taken from a local stack with made-up organizations,
fake model vendors and fake company systems. Nothing here reaches a real
account. This folder seeds that stack and walks the UI.

```
stack.sh            starts the stack for a profile (containers, fakes, API, frontend)
cli.ts              the one entry point: check, seed, capture, register
engine/             the runner: schema, steps, locators, templates, manifest checks
fakes/              the shared fake upstream server and the services plugged into it
walks/<family>/     walks as data: who signs in, the screenshots, the steps
test/               unit tests for the engine, and the manifest coverage check
```

## Run it

Node 26. From the repository root:

```sh
PROFILE=northwind scripts/demo-seed/stack.sh up    # prints the DEMO_* variables
eval "$(scripts/demo-seed/stack.sh env)"
cd scripts/demo-seed
npm run demo -- seed                        # the profile's API-only walks
npm run demo -- capture                     # every walk of the running profile
npm run demo -- capture --only guide-sales  # one walk (the walks it runs after must have run once)
npm run demo -- capture --only guide-sales --from sales-4-notes
npm run demo -- register --only guide-sales # after looking at the pixels
scripts/demo-seed/stack.sh down             # stops only what it started
```

Screenshots land in `$SHOT_DIR/<walk>/` (default `/tmp/almyty-demo/shots`).
Nothing is registered until you run `register`, which calls
`docs-site/scripts/record-screenshot.mjs` with each shot's path, title,
route and sources. A failed step stops the walk and says which walk, which
step, and where the screenshot of the page as it was is.

`npm run demo -- check` (also run in CI by `npm test`) proves the walks
parse and that every local-demo entry in the manifest is taken by exactly
one walk step, with the same title and sources.

Profiles (`walks/profiles.ts`) pick the fake upstreams and what the API is
started with. One profile runs at a time, because the fakes keep the ports
the published screenshots show; `capture` refuses a walk of another
profile. `stack.sh down` wipes the database, so each profile starts fresh.

## A walk

A walk is data, checked against `engine/schema.ts` when it loads:

```ts
{
  id: 'guide-sales', title: 'Sales: a brief before the call', profile: 'northwind',
  account: { email, password, firstName, lastName, organizationName },
  after: ['guide-support'],          // runs after these; gets what they remembered
  browser: { scale: 2, providerUrl: '{{stack.fake}}/openai/v1' },
  shots: { 'sales-3-brief': { path: 'screenshots/guides/sales-3-brief.png', title: '...', sources: ['frontend/src/...'] } },
  steps: [
    { click: { role: 'link', name: 'Agents' } },
    { fill: { label: 'Instructions' }, value: '...' },
    { waitFor: { role: 'status', hasText: /Kestrel/ }, timeout: 60000 },
    { shot: 'sales-3-brief' },
  ],
}
```

Elements are found the way a reader finds them: `role` and `name`, `label`,
`placeholder`, `title` or `testid`, optionally `within` another element,
`hasText` and `nth`. `text` is allowed only for what a step waits for or
scrolls to; the schema refuses it as the target of a click or a fill. When
an element has no accessible handle, add a `data-testid` to the product.

There are no fixed sleeps. Steps that navigate or click wait until the page
has had no request in flight for half a second (open event streams aside);
a screenshot also waits for fonts, for `aria-busy` to clear, and freezes
animations. Wait for anything else on its real condition with `waitFor`,
`waitForUrl` or `until`.

Steps, by their leading key:

| step | does |
| --- | --- |
| `goto`, `reload` | open a path on the app |
| `click`, `fill` + `value`, `press` + `key`, `key` | act on an element, or press a key on the page |
| `check`, `uncheck` (+ `all`), `setChecks` + `on` | tick boxes; `setChecks` ticks those whose label matches and clears the rest |
| `select` + `option` (+ `search`) | open a combobox and pick an option |
| `upload` + `file`, `download` + `save` | files in and out |
| `expand` | open every match that is not `aria-expanded` |
| `waitFor` (+ `state`), `waitForUrl`, `until` | wait for an element, an address, or a condition |
| `scrollTo` (+ `offset`, `block`), `scrollTop`, `scrollBy`, `viewport` | frame the screenshot |
| `shot` (+ `clip`, `pad`) | take a declared screenshot; each is taken by exactly one step |
| `render` + `with` + `shot` | show what a fake received (an email, Slack messages) with a page template, and take it |
| `remember` (`value`, `fromUrl`, `fromInput`) | keep a value for later steps and later walks |
| `http` (+ `save`), `sql` (+ `save`), `ensure` | call the API or a fake, query the database, find-or-create by name |
| `if` / `then` / `else`, `repeat` + `while` + `max`, `each` + `as` + `do` | control flow; no screenshot inside a loop |
| `as` + `do` | the steps as another person from the walk's `people` |
| `use` + `with` | a macro (`engine/macros.ts`, or the family's own): its steps go in its place before the walk is checked |
| `action` + `with` | a named, typed function for what is not a click or a call (`engine/actions.ts`, or the family's own) |

Conditions (`until`, `if`, `while`): `visible`, `hidden`, `enabled`,
`checked`, `url`, `sql` (+ `is`/`not`), `http` (+ `at`, `where`, `min`),
`value` (+ `is`), and `not`.

Strings are templates: `{{agents.support.id}}`, `{{stack.fake}}`,
`{{env.NAME}}`, `{{org.id}}`, `{{me.id}}`, with filters such as
`{{tools|where:name~^petstore_|map:id}}`, `{{list|rows:agents|first|get:id}}`,
`{{$now|add:2m|hhmm}}`, `{{$uuid}}`, `{{payload|sqljson}}`. A string that is
one placeholder becomes the value itself. `{{!input.days}}` stays
`{{input.days}}`, for the product's own templates.

## Fakes

`fakes/server.ts` is the one fake upstream server: a route table, JSON
bodies, a request log, `/health`, both loopback addresses. `fakes/openai.ts`
speaks the OpenAI wire format (models, chat with streaming, embeddings) for
a service's scripted model. A service is a module in `fakes/services/`
that exports routes and keeps its own state; `fakes/serve.ts` starts the
ones a profile names. Modules in `fakes/preload/` are loaded into the API
to send its calls to real services to a fake instead.

## Tests

```sh
npm test            # engine, schema, templates, fakes, and the manifest check
npm run typecheck
```
