import React, { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { CodeBlock } from '@/components/ui/code-block'

// ---------------------------------------------------------------------------
// Table of Contents definition
// ---------------------------------------------------------------------------

interface TocItem {
  id: string
  label: string
  children?: TocItem[]
}

const TOC: TocItem[] = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    children: [
      { id: 'connect-api', label: 'Connect an API' },
      { id: 'import-schema', label: 'Import a Schema' },
      { id: 'generate-tools', label: 'Generate Tools' },
      { id: 'create-gateway', label: 'Create a Gateway' },
      { id: 'build-agent', label: 'Build Your First Agent' },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    children: [
      { id: 'agent-pipelines', label: 'Agent Pipelines' },
      { id: 'node-types', label: 'Node Types' },
      { id: 'template-expressions', label: 'Template Expressions' },
      { id: 'pipeline-validation', label: 'Pipeline Validation' },
      { id: 'versioning-rollback', label: 'Versioning & Rollback' },
      { id: 'webhooks', label: 'Webhooks' },
      { id: 'scheduling', label: 'Scheduling' },
    ],
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    children: [
      { id: 'authentication', label: 'Authentication' },
      { id: 'agents-api', label: 'Agents API' },
      { id: 'openai-compat', label: 'OpenAI Compatible API' },
      { id: 'error-codes', label: 'Error Codes' },
      { id: 'rate-limits', label: 'Rate Limits' },
    ],
  },
  {
    id: 'gateways',
    label: 'Gateways',
    children: [
      { id: 'mcp-protocol', label: 'MCP Protocol' },
      { id: 'a2a-protocol', label: 'A2A Protocol' },
      { id: 'utcp-protocol', label: 'UTCP Protocol' },
      { id: 'skills-protocol', label: 'Skills Protocol' },
      { id: 'gateway-auth', label: 'Gateway Authentication' },
      { id: 'tool-scoping', label: 'Tool Scoping' },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    children: [
      { id: 'auto-generated-tools', label: 'Auto-Generated Tools' },
      { id: 'http-tools', label: 'HTTP Tools' },
      { id: 'javascript-tools', label: 'JavaScript Tools' },
      { id: 'graphql-tools', label: 'GraphQL Tools' },
      { id: 'llm-tools', label: 'LLM Tools' },
      { id: 'tool-execution', label: 'Tool Execution & Testing' },
    ],
  },
  {
    id: 'organizations',
    label: 'Organizations & RBAC',
  },
]

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

function Sidebar({ activeId }: { activeId: string }) {
  return (
    <nav className="space-y-1">
      {TOC.map((item) => (
        <div key={item.id}>
          <a
            href={`#${item.id}`}
            className={cn(
              'block text-sm font-medium py-1.5 px-2 rounded-md transition-colors',
              activeId === item.id
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            {item.label}
          </a>
          {item.children && (
            <div className="ml-3 border-l border-border/50 pl-2 space-y-0.5">
              {item.children.map((child) => (
                <a
                  key={child.id}
                  href={`#${child.id}`}
                  className={cn(
                    'block text-xs py-1 px-2 rounded-md transition-colors',
                    activeId === child.id
                      ? 'text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {child.label}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Reusable prose elements
// ---------------------------------------------------------------------------

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-2xl font-bold tracking-tight mt-12 mb-4 scroll-mt-6 border-b pb-2 border-border/50">
      {children}
    </h2>
  )
}

function H3({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-lg font-semibold mt-8 mb-3 scroll-mt-6">
      {children}
    </h3>
  )
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-sm leading-relaxed text-muted-foreground mb-3', className)}>{children}</p>
}

function Code({ children }: { children: string }) {
  return (
    <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground">{children}</code>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 mb-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground mb-1">{title}</p>
        <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
      </div>
    </div>
  )
}

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  const colors: Record<string, string> = {
    GET: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    POST: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    PUT: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    DELETE: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  }
  return (
    <div className="flex items-start gap-2 py-2 border-b border-border/30 last:border-0">
      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider flex-shrink-0 mt-0.5', colors[method] || 'bg-muted')}>
        {method}
      </span>
      <code className="text-xs font-mono text-foreground flex-shrink-0">{path}</code>
      <span className="text-xs text-muted-foreground ml-auto">{desc}</span>
    </div>
  )
}

function NodeTypeCard({ name, badge, children }: { name: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-4 mb-3 bg-card">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold text-sm text-foreground">{name}</span>
        {badge && <Badge variant="outline" className="text-[10px]">{badge}</Badge>}
      </div>
      <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function DocsPage() {
  const [activeId, setActiveId] = useState('getting-started')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = 'Documentation | apifai'
    return () => { document.title = 'apifai' }
  }, [])

  // Track which section is in view
  useEffect(() => {
    const allIds = TOC.flatMap((s) => [s.id, ...(s.children?.map((c) => c.id) || [])])
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
            break
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )

    for (const id of allIds) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex gap-8 max-w-7xl mx-auto">
      {/* Left sidebar — sticky TOC */}
      <aside className="hidden lg:block w-56 flex-shrink-0">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pb-8">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">On this page</p>
          <Sidebar activeId={activeId} />
        </div>
      </aside>

      {/* Right content */}
      <div ref={contentRef} className="flex-1 min-w-0 pb-24">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
          <p className="text-muted-foreground mt-1">Everything you need to turn APIs into AI-ready tools.</p>
        </div>

        {/* ================================================================ */}
        {/* GETTING STARTED                                                   */}
        {/* ================================================================ */}

        <H2 id="getting-started">Getting Started</H2>
        <P>
          apifai turns any API into AI-ready tools in five steps: connect an API, import its schema,
          generate tools, create a gateway to serve them, and optionally build an agent pipeline that
          orchestrates LLM calls and tool executions.
        </P>

        <H3 id="connect-api">1. Connect an API</H3>
        <Step n={1} title="Navigate to the APIs page">
          Click <strong>APIs</strong> in the left sidebar. If you have no APIs yet, you will see an
          empty state with a prompt to add one.
        </Step>
        <Step n={2} title='Click "Connect API"'>
          The dialog asks for a <strong>name</strong>, <strong>base URL</strong> (e.g.{' '}
          <Code>https://petstore.swagger.io/v2</Code>), and <strong>API type</strong> (OpenAPI,
          GraphQL, SOAP, or Protobuf). Fill these in and click <strong>Create</strong>.
        </Step>
        <Step n={3} title="Review the API detail page">
          After creation you land on the API detail page showing the base URL, type badge, and an
          empty operations list. The next step is to import a schema so operations can be discovered.
        </Step>

        <H3 id="import-schema">2. Import a Schema</H3>
        <P>
          Schemas describe the available operations, parameters, request bodies, and response shapes
          of your API. apifai supports four formats:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><strong className="text-foreground">OpenAPI 3.x / Swagger 2.0</strong> -- JSON or YAML, URL or paste</li>
          <li><strong className="text-foreground">GraphQL</strong> -- Introspection query or SDL</li>
          <li><strong className="text-foreground">SOAP / WSDL</strong> -- WSDL URL or XML content</li>
          <li><strong className="text-foreground">Protobuf</strong> -- .proto file contents</li>
        </ul>
        <Step n={1} title="Open the Import dialog">
          On the API detail page, click <strong>Import Schema</strong>. Choose between providing a
          URL (e.g. <Code>https://petstore.swagger.io/v2/swagger.json</Code>) or pasting the schema
          content directly.
        </Step>
        <Step n={2} title="Wait for parsing">
          The schema is parsed in a background job. For large schemas (hundreds of endpoints) this
          may take 10--30 seconds. A progress indicator shows the import status.
        </Step>
        <Step n={3} title="Review discovered operations">
          Once complete, the API detail page lists all operations with their HTTP method, path,
          summary, and parameters. Each operation can become a tool.
        </Step>

        <H3 id="generate-tools">3. Generate Tools</H3>
        <Step n={1} title="Click Generate Tools">
          On the API detail page, click the <strong>Generate Tools</strong> button. This creates one
          tool per discovered operation, automatically mapping parameters, request bodies, headers,
          and authentication.
        </Step>
        <Step n={2} title="Review on the Tools page">
          Navigate to <strong>Tools</strong> in the sidebar. You will see your auto-generated tools
          listed with their names, descriptions, API source, and type badge.
        </Step>
        <P>
          You can also create <strong>custom tools</strong> manually -- HTTP, JavaScript, GraphQL, or
          LLM-powered -- using the <strong>Create Tool</strong> button. See the{' '}
          <a href="#tools" className="text-primary underline">Tools</a> section for details.
        </P>

        <H3 id="create-gateway">4. Create a Gateway</H3>
        <P>
          Gateways expose your tools over a protocol that AI agents can consume.
        </P>
        <Step n={1} title="Navigate to Gateways and click Create">
          Choose a <strong>protocol type</strong>: MCP, A2A, UTCP, or Skills. Give the gateway a
          name and an endpoint path (e.g. <Code>/my-tools</Code>).
        </Step>
        <Step n={2} title="Assign tools">
          On the gateway detail page, use the <strong>Tool Scoping</strong> section to select which
          tools to expose through this gateway. You can assign all tools or pick specific ones.
        </Step>
        <Step n={3} title="Connect your AI agent">
          Copy the gateway URL from the integrations section and configure your AI client. For MCP
          gateways, use the MCP server URL in Claude, Cursor, Windsurf, or any MCP-compatible client.
        </Step>

        <H3 id="build-agent">5. Build Your First Agent</H3>
        <Step n={1} title="Navigate to Agents and click Create Agent">
          This opens the visual pipeline builder with three default nodes: <strong>Input</strong>,{' '}
          <strong>LLM Call</strong>, and <strong>Output</strong>.
        </Step>
        <Step n={2} title="Configure the LLM Call node">
          Click the LLM Call node on the canvas. In the config panel, select a <strong>provider</strong>{' '}
          (you must have at least one AI Model configured under <strong>AI Models</strong> in the sidebar),
          choose a <strong>model</strong>, write a <strong>system prompt</strong>, and optionally
          attach tools for the LLM to call.
        </Step>
        <Step n={3} title="Save and invoke">
          Give your agent a name, click <strong>Save</strong>, then test it with the <strong>Try It</strong>{' '}
          panel or invoke it via API at <Code>POST /agents/:id/invoke</Code>.
        </Step>

        {/* ================================================================ */}
        {/* AGENTS                                                            */}
        {/* ================================================================ */}

        <H2 id="agents">Agents</H2>
        <P>
          Agents are executable pipelines that orchestrate LLM calls, tool executions, conditional
          branching, data transformations, and parallel execution into a single invocable unit.
          You build them visually in the pipeline builder by dragging nodes onto a canvas and
          connecting them with edges.
        </P>

        <H3 id="agent-pipelines">Agent Pipelines</H3>
        <P>
          A pipeline is a directed acyclic graph (DAG) of nodes. Execution starts at the
          <strong> Input</strong> node and flows through connected nodes until it reaches an
          <strong> Output</strong> node. Each node receives data from its upstream connections and
          passes its result downstream.
        </P>
        <P>
          The builder canvas supports drag-to-connect: drag from an output handle (right side of a
          node) to an input handle (left side) to create an edge. Nodes can be added by dragging
          them from the <strong>Node Types</strong> palette on the left.
        </P>

        <H3 id="node-types">Node Types</H3>
        <P>There are nine node types, each serving a distinct role in the pipeline:</P>

        <NodeTypeCard name="Input" badge="required">
          <p className="mb-2">The entry point of every pipeline. Defines the JSON schema for the data the agent expects when invoked.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Schema</strong> -- JSON Schema object describing expected input fields (type, properties, required)</li>
            <li><strong>Default values</strong> -- Optional defaults for each field</li>
          </ul>
          <p className="mt-2 text-xs">Every pipeline must have exactly one Input node. Downstream nodes access input data via <Code>{'{{input.fieldName}}'}</Code>.</p>
        </NodeTypeCard>

        <NodeTypeCard name="Output" badge="required">
          <p className="mb-2">The exit point. Maps the final result that callers receive.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Mapping expression</strong> -- A template expression like <Code>{'{{nodes.llm_1.output}}'}</Code> that selects which upstream node's output becomes the agent's response</li>
          </ul>
          <p className="mt-2 text-xs">Every pipeline must have exactly one Output node.</p>
        </NodeTypeCard>

        <NodeTypeCard name="LLM Call">
          <p className="mb-2">Sends a prompt to a language model and returns the completion. Supports tool calling loops where the LLM can invoke tools and iterate.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Provider</strong> -- Select from configured AI Models (OpenAI, Anthropic, Azure OpenAI, etc.)</li>
            <li><strong>Model</strong> -- Specific model name (gpt-4, claude-3-opus, etc.)</li>
            <li><strong>System prompt</strong> -- Instructions that set the LLM's behavior and context</li>
            <li><strong>User prompt template</strong> -- Template for the user message, can reference upstream data via <Code>{'{{input.query}}'}</Code></li>
            <li><strong>Temperature</strong> -- Controls randomness (0.0 = deterministic, 1.0 = creative)</li>
            <li><strong>Max tokens</strong> -- Maximum response length</li>
            <li><strong>Tools</strong> -- Optionally attach tools the LLM can call; enables a tool-calling loop where the LLM can invoke tools, read results, and iterate</li>
          </ul>
          <p className="mt-2 text-xs"><strong>Tool calling loop:</strong> When tools are attached, the LLM may return tool_call messages. The runtime automatically executes those tools, feeds results back to the LLM, and repeats until the LLM produces a final text response (up to a configurable max iterations).</p>
        </NodeTypeCard>

        <NodeTypeCard name="Tool Call">
          <p className="mb-2">Executes a specific tool (auto-generated or custom) with given parameters.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Tool selection</strong> -- Pick from any tool in your organization</li>
            <li><strong>Parameter mapping</strong> -- Map each tool parameter to a value or template expression. Example: <Code>{'{{input.userId}}'}</Code> or <Code>{'{{nodes.llm_1.output.extractedId}}'}</Code></li>
          </ul>
          <p className="mt-2 text-xs">The node's output is the raw tool execution result, accessible to downstream nodes.</p>
        </NodeTypeCard>

        <NodeTypeCard name="Condition">
          <p className="mb-2">Evaluates a boolean expression and branches execution to one of two paths: true or false.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Expression</strong> -- A JavaScript expression that evaluates to true/false. Examples:</li>
          </ul>
          <CodeBlock
            value={`// Simple equality
{{nodes.tool_1.output.status}} === "success"

// Numeric comparison
{{nodes.llm_1.output.confidence}} > 0.8

// Existence check
{{input.optionalField}} !== undefined`}
            language="javascript"
            copyable={false}
            maxHeight="120px"
            className="mt-2 text-xs"
          />
          <p className="mt-2 text-xs">The true output handle connects to the path taken when the expression is truthy; the false handle connects to the alternative path.</p>
        </NodeTypeCard>

        <NodeTypeCard name="Transform">
          <p className="mb-2">Reshapes or computes data using a JavaScript expression. Useful for extracting fields, formatting strings, or combining data from multiple upstream nodes.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Expression</strong> -- A JavaScript expression that produces the transformed value. The result becomes this node's output.</li>
          </ul>
          <CodeBlock
            value={`// Extract a field
{{nodes.tool_1.output.data.items}}

// Format a string
"Hello, " + {{input.name}} + "! Your results: " + JSON.stringify({{nodes.tool_1.output}})

// Build a new object
({ summary: {{nodes.llm_1.output}}, count: {{nodes.tool_1.output.data.length}} })`}
            language="javascript"
            copyable={false}
            maxHeight="120px"
            className="mt-2 text-xs"
          />
        </NodeTypeCard>

        <NodeTypeCard name="Merge">
          <p className="mb-2">Combines results from multiple upstream branches into a single output. Used after Parallel nodes or Condition nodes to rejoin split paths.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Strategy</strong> -- How to combine inputs:</li>
          </ul>
          <ul className="list-disc list-inside ml-6 space-y-0.5 text-xs mt-1">
            <li><Code>first_response</Code> -- Use the first branch that completes (fastest wins)</li>
            <li><Code>best_of_n</Code> -- Run all branches and pick the best result (requires a scoring expression)</li>
            <li><Code>concatenate</Code> -- Append all results into an array</li>
            <li><Code>consensus</Code> -- Compare results and return the most common answer</li>
          </ul>
        </NodeTypeCard>

        <NodeTypeCard name="Parallel">
          <p className="mb-2">Fans out execution to multiple downstream branches that run concurrently. Useful for calling multiple tools or LLMs at the same time.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Max concurrency</strong> -- Limit how many branches run simultaneously (default: unlimited)</li>
            <li><strong>Timeout</strong> -- Max time to wait for all branches before failing</li>
          </ul>
          <p className="mt-2 text-xs">Typically paired with a downstream Merge node that recombines the parallel results.</p>
        </NodeTypeCard>

        <NodeTypeCard name="Sub-Agent">
          <p className="mb-2">Invokes another agent as a nested step. This enables composition -- break complex pipelines into reusable sub-agents.</p>
          <p className="mb-1 font-medium text-foreground text-xs">Configuration:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-xs">
            <li><strong>Agent selection</strong> -- Pick from any published agent in your organization</li>
            <li><strong>Input mapping</strong> -- Map data to the sub-agent's expected input schema</li>
            <li><strong>Depth limit</strong> -- Maximum nesting depth to prevent infinite recursion (default: 5)</li>
          </ul>
        </NodeTypeCard>

        <H3 id="template-expressions">Template Expressions</H3>
        <P>
          Template expressions let nodes reference data from the input or from other nodes' outputs.
          They use double-curly-brace syntax:
        </P>
        <CodeBlock
          value={`// Reference the pipeline input
{{input}}                          // entire input object
{{input.query}}                    // specific field
{{input.options.maxResults}}       // nested field

// Reference another node's output
{{nodes.llm_1.output}}             // full output of node "llm_1"
{{nodes.tool_1.output.data}}       // nested field in tool output
{{nodes.transform_1.output[0]}}    // array indexing

// Combine in strings (inside prompt templates)
"Summarize this: {{input.text}}"
"Previous answer: {{nodes.llm_1.output}}"`}
          language="text"
          className="mb-4"
          maxHeight="200px"
        />
        <P>
          Expressions are evaluated at runtime. If a referenced node has not yet executed (e.g.
          it is downstream or on a different branch), the expression resolves to <Code>undefined</Code>.
        </P>

        <H3 id="pipeline-validation">Pipeline Validation</H3>
        <P>
          The builder validates your pipeline in real time and shows warnings in a banner at the top
          of the page. Common validation rules:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li>Every pipeline must have exactly one <strong className="text-foreground">Input</strong> node and one <strong className="text-foreground">Output</strong> node</li>
          <li>Every <strong className="text-foreground">LLM Call</strong> node must have a provider and model selected</li>
          <li>All nodes must be connected -- orphan nodes are flagged</li>
          <li>The graph must be acyclic (no loops allowed)</li>
          <li>Condition nodes must have both true and false outputs connected</li>
          <li>Parallel nodes must have at least two downstream branches</li>
          <li>Sub-Agent nodes must reference an existing published agent</li>
        </ul>
        <P>
          The <strong>Save</strong> button is disabled until all validation errors are resolved.
        </P>

        <H3 id="versioning-rollback">Versioning & Rollback</H3>
        <P>
          Every time you save an agent, a new <strong>version</strong> is created. The agent detail
          page shows the version history with timestamps and diffs. You can:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><strong className="text-foreground">View any version</strong> -- See the pipeline as it was at that point in time</li>
          <li><strong className="text-foreground">Rollback</strong> -- Revert to a previous version with one click</li>
          <li><strong className="text-foreground">Compare</strong> -- See what changed between two versions</li>
        </ul>
        <P>
          The active version is always the latest save. Rollback creates a new version that copies
          the selected version's pipeline definition.
        </P>

        <H3 id="webhooks">Webhooks</H3>
        <P>
          Agents can be triggered by external webhooks. On the agent detail page, enable the webhook
          trigger to get a unique URL. Any POST request to that URL will invoke the agent with the
          request body as input.
        </P>
        <CodeBlock
          value={`POST https://api.apif.ai/agents/:id/webhook
Content-Type: application/json

{
  "query": "What is the weather?",
  "context": { "userId": "abc123" }
}`}
          language="http"
          className="mb-4"
        />
        <P>
          Webhook invocations appear in the execution history like any other invocation. You can
          configure webhook secrets for signature verification.
        </P>

        <H3 id="scheduling">Scheduling</H3>
        <P>
          Agents can run on a schedule using cron expressions. On the agent detail page, add a
          schedule trigger:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><Code>*/5 * * * *</Code> -- Every 5 minutes</li>
          <li><Code>0 9 * * *</Code> -- Daily at 9:00 AM UTC</li>
          <li><Code>0 0 * * MON</Code> -- Every Monday at midnight</li>
        </ul>
        <P>
          Scheduled runs use a fixed input that you configure when setting up the schedule. Results
          are logged in the execution history.
        </P>

        {/* ================================================================ */}
        {/* API REFERENCE                                                     */}
        {/* ================================================================ */}

        <H2 id="api-reference">API Reference</H2>
        <P>
          All API endpoints are available at your instance's base URL (e.g. <Code>https://api.apif.ai</Code>
          {' '}for production or your staging URL).
        </P>

        <H3 id="authentication">Authentication</H3>
        <P>apifai supports two authentication methods:</P>

        <p className="text-sm font-medium text-foreground mt-4 mb-2">JWT Token (from login)</p>
        <CodeBlock
          value={`POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your-password"
}

// Response:
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs..."
}`}
          language="http"
          className="mb-3"
        />
        <P>
          Include the token in all subsequent requests:
        </P>
        <CodeBlock
          value={`Authorization: Bearer eyJhbGciOiJIUzI1NiIs...`}
          language="http"
          className="mb-3"
        />

        <p className="text-sm font-medium text-foreground mt-4 mb-2">API Key</p>
        <P>
          Create an API key from <strong>Settings &gt; API Keys</strong>. API keys are scoped to an
          organization and can have read-only or full access.
        </P>
        <CodeBlock
          value={`Authorization: Bearer apifai_key_xxxxxxxxxxxx`}
          language="http"
          className="mb-4"
        />

        <H3 id="agents-api">Agents API</H3>
        <div className="border rounded-lg overflow-hidden mb-4">
          <div className="p-3 space-y-0">
            <Endpoint method="POST" path="/agents" desc="Create a new agent" />
            <Endpoint method="GET" path="/agents" desc="List all agents" />
            <Endpoint method="GET" path="/agents/:id" desc="Get agent details" />
            <Endpoint method="PATCH" path="/agents/:id" desc="Update an agent" />
            <Endpoint method="DELETE" path="/agents/:id" desc="Delete an agent" />
            <Endpoint method="POST" path="/agents/:id/invoke" desc="Execute an agent" />
            <Endpoint method="POST" path="/agents/:id/stream" desc="Execute with SSE streaming" />
          </div>
        </div>

        <p className="text-sm font-medium text-foreground mt-4 mb-2">Create an agent</p>
        <CodeBlock
          value={`POST /agents
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Customer Support Agent",
  "description": "Handles customer inquiries using knowledge base tools",
  "pipeline": {
    "nodes": [
      { "id": "input_1", "type": "input", "config": { "schema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } } },
      { "id": "llm_1", "type": "llm_call", "config": { "providerId": "<provider-id>", "model": "gpt-4", "systemPrompt": "You are a helpful assistant.", "tools": ["<tool-id-1>", "<tool-id-2>"] } },
      { "id": "output_1", "type": "output", "config": { "mapping": "{{nodes.llm_1.output}}" } }
    ],
    "edges": [
      { "source": "input_1", "target": "llm_1" },
      { "source": "llm_1", "target": "output_1" }
    ]
  }
}`}
          language="json"
          className="mb-3"
        />

        <p className="text-sm font-medium text-foreground mt-4 mb-2">Invoke an agent</p>
        <CodeBlock
          value={`POST /agents/:id/invoke
Content-Type: application/json
Authorization: Bearer <token>

{
  "input": {
    "query": "How do I reset my password?"
  }
}

// Response:
{
  "success": true,
  "data": {
    "output": "To reset your password, go to Settings > Account...",
    "executionId": "exec_abc123",
    "duration": 2340,
    "tokensUsed": 450
  }
}`}
          language="json"
          className="mb-3"
        />

        <p className="text-sm font-medium text-foreground mt-4 mb-2">Stream an agent (SSE)</p>
        <CodeBlock
          value={`POST /agents/:id/stream
Content-Type: application/json
Authorization: Bearer <token>

{
  "input": { "query": "Explain quantum computing" }
}

// SSE Response:
data: {"type":"start","executionId":"exec_abc123"}

data: {"type":"node_start","nodeId":"llm_1"}

data: {"type":"token","content":"Quantum"}

data: {"type":"token","content":" computing"}

data: {"type":"node_complete","nodeId":"llm_1","output":"Quantum computing is..."}

data: {"type":"complete","output":"Quantum computing is...","duration":3200}`}
          language="text"
          className="mb-3"
        />

        <H3 id="openai-compat">OpenAI Compatible API</H3>
        <P>
          apifai exposes an OpenAI-compatible chat completions endpoint so you can use agents from
          any OpenAI SDK or client by changing the base URL and model name.
        </P>
        <CodeBlock
          value={`POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <token>

{
  "model": "agent:customer-support",
  "messages": [
    { "role": "user", "content": "How do I reset my password?" }
  ],
  "stream": false
}

// Response follows OpenAI chat completion format:
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "To reset your password..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 85, "total_tokens": 97 }
}`}
          language="json"
          className="mb-3"
        />

        <p className="text-sm font-medium text-foreground mt-4 mb-2">List available models</p>
        <CodeBlock
          value={`GET /v1/models
Authorization: Bearer <token>

// Response:
{
  "object": "list",
  "data": [
    { "id": "agent:customer-support", "object": "model", "owned_by": "apifai" },
    { "id": "agent:data-analyst", "object": "model", "owned_by": "apifai" }
  ]
}`}
          language="json"
          className="mb-3"
        />

        <P>
          Use with the OpenAI Python SDK:
        </P>
        <CodeBlock
          value={`from openai import OpenAI

client = OpenAI(
    base_url="https://api.apif.ai/v1",
    api_key="apifai_key_xxxxxxxxxxxx"
)

response = client.chat.completions.create(
    model="agent:customer-support",
    messages=[{"role": "user", "content": "How do I reset my password?"}]
)

print(response.choices[0].message.content)`}
          language="python"
          className="mb-4"
        />

        <H3 id="error-codes">Error Codes</H3>
        <div className="border rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left py-2 px-3 font-medium">Code</th>
                <th className="text-left py-2 px-3 font-medium">Meaning</th>
                <th className="text-left py-2 px-3 font-medium">Common Causes</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground text-xs">
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">400</td><td className="py-2 px-3">Bad Request</td><td className="py-2 px-3">Invalid JSON, missing required fields, schema validation failure</td></tr>
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">401</td><td className="py-2 px-3">Unauthorized</td><td className="py-2 px-3">Missing or expired token, invalid API key</td></tr>
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">403</td><td className="py-2 px-3">Forbidden</td><td className="py-2 px-3">Insufficient permissions (e.g. viewer trying to create)</td></tr>
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">404</td><td className="py-2 px-3">Not Found</td><td className="py-2 px-3">Resource does not exist or belongs to a different organization</td></tr>
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">409</td><td className="py-2 px-3">Conflict</td><td className="py-2 px-3">Duplicate name, resource already exists</td></tr>
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">422</td><td className="py-2 px-3">Unprocessable Entity</td><td className="py-2 px-3">Pipeline validation failed, invalid expression syntax</td></tr>
              <tr className="border-b"><td className="py-2 px-3 font-mono text-foreground">429</td><td className="py-2 px-3">Too Many Requests</td><td className="py-2 px-3">Rate limit exceeded</td></tr>
              <tr><td className="py-2 px-3 font-mono text-foreground">500</td><td className="py-2 px-3">Internal Server Error</td><td className="py-2 px-3">Unexpected error -- contact support</td></tr>
            </tbody>
          </table>
        </div>
        <P>Error responses follow a consistent format:</P>
        <CodeBlock
          value={`{
  "statusCode": 422,
  "message": "Pipeline validation failed: LLM Call node 'llm_1' is missing a provider",
  "error": "Unprocessable Entity"
}`}
          language="json"
          className="mb-4"
        />

        <H3 id="rate-limits">Rate Limits</H3>
        <P>
          Rate limits apply per API key or JWT token:
        </P>
        <div className="border rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left py-2 px-3 font-medium">Endpoint</th>
                <th className="text-left py-2 px-3 font-medium">Limit</th>
                <th className="text-left py-2 px-3 font-medium">Window</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground text-xs">
              <tr className="border-b"><td className="py-2 px-3 text-foreground">Agent invocations</td><td className="py-2 px-3">100 requests</td><td className="py-2 px-3">per minute</td></tr>
              <tr className="border-b"><td className="py-2 px-3 text-foreground">Tool executions</td><td className="py-2 px-3">200 requests</td><td className="py-2 px-3">per minute</td></tr>
              <tr className="border-b"><td className="py-2 px-3 text-foreground">Gateway endpoints</td><td className="py-2 px-3">500 requests</td><td className="py-2 px-3">per minute</td></tr>
              <tr><td className="py-2 px-3 text-foreground">CRUD operations</td><td className="py-2 px-3">60 requests</td><td className="py-2 px-3">per minute</td></tr>
            </tbody>
          </table>
        </div>
        <P>
          Rate limit headers are included in every response: <Code>X-RateLimit-Limit</Code>,{' '}
          <Code>X-RateLimit-Remaining</Code>, <Code>X-RateLimit-Reset</Code>.
        </P>

        {/* ================================================================ */}
        {/* GATEWAYS                                                          */}
        {/* ================================================================ */}

        <H2 id="gateways">Gateways</H2>
        <P>
          Gateways are protocol-specific endpoints that expose your tools to AI agents and clients.
          Each gateway can serve a curated subset of your tools via one of four protocols.
        </P>

        <H3 id="mcp-protocol">MCP Protocol</H3>
        <P>
          The <strong>Model Context Protocol (MCP)</strong> is a JSON-RPC 2.0 based protocol for
          tool discovery and execution. apifai MCP gateways support three transports:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-3 ml-2">
          <li><strong className="text-foreground">HTTP</strong> -- Standard request/response. Client sends JSON-RPC requests, gets JSON-RPC responses.</li>
          <li><strong className="text-foreground">SSE (Server-Sent Events)</strong> -- Server pushes results as they become available. Good for long-running tool executions.</li>
          <li><strong className="text-foreground">WebSocket</strong> -- Full-duplex communication for real-time tool interactions.</li>
        </ul>
        <p className="text-sm font-medium text-foreground mt-4 mb-2">Integration example (Claude Desktop)</p>
        <CodeBlock
          value={`// claude_desktop_config.json
{
  "mcpServers": {
    "my-tools": {
      "url": "https://api.apif.ai/gateways/<gateway-id>/mcp"
    }
  }
}`}
          language="json"
          className="mb-3"
        />
        <p className="text-sm font-medium text-foreground mt-4 mb-2">Integration example (Cursor)</p>
        <CodeBlock
          value={`// .cursor/mcp.json
{
  "mcpServers": {
    "apifai-tools": {
      "url": "https://api.apif.ai/gateways/<gateway-id>/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}`}
          language="json"
          className="mb-4"
        />

        <H3 id="a2a-protocol">A2A Protocol</H3>
        <P>
          The <strong>Agent-to-Agent (A2A)</strong> protocol enables AI agents to discover and
          communicate with each other. An A2A gateway publishes an agent card that describes the
          agent's capabilities, skills, and communication endpoints.
        </P>
        <CodeBlock
          value={`GET /gateways/<gateway-id>/a2a/.well-known/agent.json

// Response: Agent Card
{
  "name": "My Tool Agent",
  "description": "Provides access to customer data tools",
  "url": "https://api.apif.ai/gateways/<gateway-id>/a2a",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "skills": [
    { "id": "get-customer", "name": "Get Customer", "description": "..." }
  ]
}`}
          language="json"
          className="mb-4"
        />

        <H3 id="utcp-protocol">UTCP Protocol</H3>
        <P>
          The <strong>Universal Tool Call Protocol (UTCP)</strong> provides a standardized REST
          interface for tool discovery and execution. It is a simpler alternative to MCP for clients
          that prefer plain HTTP.
        </P>
        <CodeBlock
          value={`# List available tools
GET /gateways/<gateway-id>/utcp/tools

# Execute a tool
POST /gateways/<gateway-id>/utcp/tools/<tool-name>/execute
Content-Type: application/json

{ "parameters": { "query": "search term" } }`}
          language="http"
          className="mb-4"
        />

        <H3 id="skills-protocol">Skills Protocol</H3>
        <P>
          The <strong>Skills</strong> protocol generates <Code>SKILL.md</Code> files -- markdown
          files that describe a tool's capabilities, parameters, and usage examples in a format
          readable by AI agents that support the{' '}
          <a href="https://agentskills.io" className="text-primary underline" target="_blank" rel="noopener">agentskills.io</a>{' '}
          specification.
        </P>
        <p className="text-sm font-medium text-foreground mt-4 mb-2">Skills CLI</p>
        <P>
          The CLI automatically installs <Code>SKILL.md</Code> files into 30+ AI agents (Claude Code,
          Cursor, Windsurf, Cline, Aider, GitHub Copilot, and more):
        </P>
        <CodeBlock
          value={`# Install skills from a gateway into all detected agents
npx @apifai/skills install --gateway <gateway-id>

# Watch mode: auto-reinstall when tools change
npx @apifai/skills watch --gateway <gateway-id>

# List installed skills
npx @apifai/skills list

# Remove all installed skills
npx @apifai/skills remove`}
          language="bash"
          className="mb-4"
        />

        <H3 id="gateway-auth">Gateway Authentication</H3>
        <P>
          Gateways support multiple authentication methods that clients must use when connecting:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><strong className="text-foreground">None</strong> -- Open access (suitable for internal/development use)</li>
          <li><strong className="text-foreground">Bearer Token</strong> -- Requires a valid JWT or API key in the Authorization header</li>
          <li><strong className="text-foreground">API Key (header)</strong> -- Custom header with an API key (e.g. <Code>X-API-Key: key123</Code>)</li>
          <li><strong className="text-foreground">API Key (query)</strong> -- API key passed as a query parameter</li>
        </ul>
        <P>
          Configure authentication on the gateway detail page under the <strong>Authentication</strong>
          {' '}section.
        </P>

        <H3 id="tool-scoping">Tool Scoping</H3>
        <P>
          By default, a new gateway has no tools assigned. You control exactly which tools are
          exposed through each gateway:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><strong className="text-foreground">No Access</strong> -- Default; tool is not available through this gateway</li>
          <li><strong className="text-foreground">Scoped</strong> -- Tool is available; shown in the gateway's tool list</li>
          <li><strong className="text-foreground">Full Access</strong> -- All current and future tools are automatically available</li>
        </ul>
        <P>
          This allows you to create multiple gateways with different tool sets -- for example, a
          "customer-facing" gateway with read-only tools and an "internal" gateway with full CRUD
          tools.
        </P>

        {/* ================================================================ */}
        {/* TOOLS                                                             */}
        {/* ================================================================ */}

        <H2 id="tools">Tools</H2>
        <P>
          Tools are the atomic building blocks that agents and gateways consume. Each tool wraps
          an action -- an API call, a script, a GraphQL query, or an LLM prompt -- with a typed
          interface that AI models can understand and invoke.
        </P>

        <H3 id="auto-generated-tools">Auto-Generated Tools</H3>
        <P>
          When you import an API schema and click <strong>Generate Tools</strong>, apifai creates one
          tool per operation. The tool automatically inherits:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><strong className="text-foreground">Name</strong> -- Derived from operationId or path (e.g. <Code>getPetById</Code>)</li>
          <li><strong className="text-foreground">Description</strong> -- From the operation summary/description</li>
          <li><strong className="text-foreground">Parameters</strong> -- Path params, query params, headers, and request body fields with types</li>
          <li><strong className="text-foreground">Authentication</strong> -- Inherited from the API's auth configuration</li>
          <li><strong className="text-foreground">Response schema</strong> -- Expected response format for validation</li>
        </ul>
        <P>
          Supported schema formats: <strong>OpenAPI 3.x</strong>, <strong>Swagger 2.0</strong>,{' '}
          <strong>GraphQL</strong> (introspection), <strong>SOAP/WSDL</strong>, and{' '}
          <strong>Protobuf</strong>.
        </P>

        <H3 id="http-tools">HTTP Tools</H3>
        <P>
          Custom HTTP tools let you call any HTTP endpoint with full control over the request:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li><strong className="text-foreground">Method</strong> -- GET, POST, PUT, PATCH, DELETE</li>
          <li><strong className="text-foreground">URL</strong> -- Full URL with optional path parameter placeholders (e.g. <Code>{'https://api.example.com/users/{{userId}}'}</Code>)</li>
          <li><strong className="text-foreground">Headers</strong> -- Custom headers including auth tokens</li>
          <li><strong className="text-foreground">Query parameters</strong> -- Key-value pairs appended to the URL</li>
          <li><strong className="text-foreground">Body</strong> -- JSON body template with parameter placeholders</li>
        </ul>
        <CodeBlock
          value={`// Example: HTTP tool configuration
{
  "method": "POST",
  "url": "https://api.example.com/search",
  "headers": {
    "Authorization": "Bearer {{apiKey}}",
    "Content-Type": "application/json"
  },
  "body": {
    "query": "{{searchQuery}}",
    "limit": "{{maxResults}}"
  }
}`}
          language="json"
          className="mb-4"
        />

        <H3 id="javascript-tools">JavaScript Tools</H3>
        <P>
          JavaScript tools run sandboxed JS code for data transformation, computation, or
          custom logic. They execute in an isolated environment with no access to the filesystem,
          network, or Node.js APIs.
        </P>
        <CodeBlock
          value={`// Example: JavaScript tool that formats data
async function execute({ items, format }) {
  if (format === 'csv') {
    const headers = Object.keys(items[0]).join(',')
    const rows = items.map(item => Object.values(item).join(','))
    return [headers, ...rows].join('\\n')
  }

  if (format === 'summary') {
    return {
      total: items.length,
      firstItem: items[0],
      lastItem: items[items.length - 1]
    }
  }

  return items
}`}
          language="javascript"
          className="mb-4"
        />
        <P>
          Parameters are passed as the first argument. The return value becomes the tool's output.
        </P>

        <H3 id="graphql-tools">GraphQL Tools</H3>
        <P>
          GraphQL tools execute a custom query or mutation against a GraphQL endpoint:
        </P>
        <CodeBlock
          value={`// Example: GraphQL tool configuration
{
  "endpoint": "https://api.example.com/graphql",
  "query": "query GetUser($id: ID!) { user(id: $id) { name email role } }",
  "variables": {
    "id": "{{userId}}"
  },
  "headers": {
    "Authorization": "Bearer {{apiKey}}"
  }
}`}
          language="json"
          className="mb-4"
        />

        <H3 id="llm-tools">LLM Tools</H3>
        <P>
          LLM tools use a language model to generate a response based on a prompt template. They
          are useful for classification, extraction, summarization, and generation tasks where
          you want to wrap an LLM call as a reusable tool.
        </P>
        <CodeBlock
          value={`// Example: LLM tool configuration
{
  "providerId": "<provider-id>",
  "model": "gpt-4",
  "systemPrompt": "You are a sentiment analyzer. Respond with exactly one word: positive, negative, or neutral.",
  "userPromptTemplate": "Analyze the sentiment of: {{text}}",
  "temperature": 0,
  "maxTokens": 10
}`}
          language="json"
          className="mb-4"
        />

        <H3 id="tool-execution">Tool Execution & Testing</H3>
        <P>
          Every tool has an <strong>Execute</strong> panel on its detail page where you can test it
          interactively:
        </P>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-4 ml-2">
          <li>Fill in parameter values in the form</li>
          <li>Click <strong>Execute</strong> to run the tool</li>
          <li>View the response, execution time, and any errors</li>
          <li>See the full request/response details for debugging</li>
        </ul>
        <P>
          The tool detail page also shows <strong>execution history</strong> -- a log of every
          invocation with timestamp, parameters, response, duration, and status. You can filter by
          date range and status.
        </P>

        {/* ================================================================ */}
        {/* ORGANIZATIONS & RBAC                                              */}
        {/* ================================================================ */}

        <H2 id="organizations">Organizations & RBAC</H2>
        <P>
          apifai is multi-tenant. Every resource (API, tool, gateway, agent) belongs to an
          organization. Users can be members of multiple organizations and switch between them
          using the organization dropdown in the sidebar.
        </P>
        <P>Roles and their permissions:</P>
        <div className="border rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left py-2 px-3 font-medium">Role</th>
                <th className="text-left py-2 px-3 font-medium">Create</th>
                <th className="text-left py-2 px-3 font-medium">Read</th>
                <th className="text-left py-2 px-3 font-medium">Update</th>
                <th className="text-left py-2 px-3 font-medium">Delete</th>
                <th className="text-left py-2 px-3 font-medium">Manage Members</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground text-xs">
              <tr className="border-b">
                <td className="py-2 px-3 font-medium text-foreground">Owner</td>
                <td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes (+ delete org)</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 px-3 font-medium text-foreground">Admin</td>
                <td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 px-3 font-medium text-foreground">Member</td>
                <td className="py-2 px-3">Yes</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">Own only</td><td className="py-2 px-3">Own only</td><td className="py-2 px-3">No</td>
              </tr>
              <tr>
                <td className="py-2 px-3 font-medium text-foreground">Viewer</td>
                <td className="py-2 px-3">No</td><td className="py-2 px-3">Yes</td><td className="py-2 px-3">No</td><td className="py-2 px-3">No</td><td className="py-2 px-3">No</td>
              </tr>
            </tbody>
          </table>
        </div>
        <P>
          Manage members from <strong>Settings &gt; Members</strong>. You can invite users by email,
          change their role, or remove them from the organization.
        </P>
      </div>
    </div>
  )
}
