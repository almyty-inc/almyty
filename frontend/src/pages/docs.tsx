import React, { useState, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Card className="overflow-hidden">
      <CardHeader
        className="cursor-pointer select-none hover:bg-muted/30 transition-colors py-4"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{title}</CardTitle>
          <ChevronDown className={cn('h-5 w-5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-0 pb-5 text-sm leading-relaxed text-muted-foreground">
          {children}
        </CardContent>
      )}
    </Card>
  )
}

function Code({ children }: { children: string }) {
  return (
    <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-foreground">{children}</code>
  )
}

export function DocsPage() {
  useEffect(() => {
    document.title = 'Documentation | apifai'
    return () => { document.title = 'apifai' }
  }, [])

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
        <p className="text-muted-foreground mt-1">How to use apifai</p>
      </div>

      <Section title="Getting Started" defaultOpen>
        <ol className="list-decimal list-inside space-y-2">
          <li>
            <strong className="text-foreground">Connect an API</strong> -- Go to the APIs page, click "Connect API", and upload an OpenAPI spec (or paste a URL).
          </li>
          <li>
            <strong className="text-foreground">Generate tools</strong> -- Tools are auto-generated from your API operations. You can also create custom tools (HTTP, JavaScript, GraphQL, LLM-powered).
          </li>
          <li>
            <strong className="text-foreground">Create a gateway</strong> -- Serve your tools via MCP, A2A, UTCP, or Skills protocol.
          </li>
          <li>
            <strong className="text-foreground">Build an agent</strong> -- Use the visual pipeline builder to wire up LLM calls, tool executions, and data transformations.
          </li>
        </ol>
      </Section>

      <Section title="Agents">
        <div className="space-y-3">
          <p>
            Agents orchestrate LLM calls, tool executions, and data transformations into a single invocable pipeline.
          </p>
          <div>
            <p className="font-medium text-foreground mb-1">Visual Builder</p>
            <p>Drag nodes from the palette and connect them with edges. The pipeline runs left to right.</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">Node Types</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong className="text-foreground">Input</strong> -- Pipeline entry point with JSON schema</li>
              <li><strong className="text-foreground">Output</strong> -- Pipeline result mapping</li>
              <li><strong className="text-foreground">LLM Call</strong> -- Call an AI model with a system prompt</li>
              <li><strong className="text-foreground">Tool Call</strong> -- Execute any registered tool</li>
              <li><strong className="text-foreground">Condition</strong> -- Branch based on an expression (true/false)</li>
              <li><strong className="text-foreground">Transform</strong> -- Reshape data with a JavaScript expression</li>
              <li><strong className="text-foreground">Merge</strong> -- Combine results from multiple branches</li>
              <li><strong className="text-foreground">Parallel</strong> -- Fan out to run branches concurrently</li>
              <li><strong className="text-foreground">Sub-Agent</strong> -- Call another agent as a nested step</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">Invocation</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Direct API: <Code>POST /agents/:id/invoke</Code></li>
              <li>Streaming: <Code>POST /agents/:id/stream</Code></li>
              <li>OpenAI compatible: <Code>POST /v1/chat/completions</Code> with <Code>model: "agent:name"</Code></li>
            </ul>
          </div>
        </div>
      </Section>

      <Section title="Gateways">
        <div className="space-y-3">
          <p>Gateways serve your tools via protocol-specific endpoints that AI agents can consume.</p>
          <ul className="list-disc list-inside space-y-2 ml-2">
            <li>
              <strong className="text-foreground">MCP</strong> -- JSON-RPC 2.0 over HTTP, SSE, or WebSocket. Works with Claude, Cursor, Windsurf, and other MCP-compatible clients.
            </li>
            <li>
              <strong className="text-foreground">A2A</strong> -- Agent-to-Agent protocol for inter-agent communication.
            </li>
            <li>
              <strong className="text-foreground">UTCP</strong> -- Universal Tool Call Protocol for standardized tool invocation.
            </li>
            <li>
              <strong className="text-foreground">Skills</strong> -- Generates SKILL.md files that can be auto-installed into 30+ AI agents via the CLI.
            </li>
          </ul>
          <div>
            <p className="font-medium text-foreground mb-1">Skills CLI</p>
            <pre className="bg-muted rounded-lg p-3 font-mono text-xs overflow-auto mt-1">
{`npx @apifai/skills install --gateway <id>
npx @apifai/skills watch --gateway <id>
npx @apifai/skills list
npx @apifai/skills remove`}
            </pre>
          </div>
        </div>
      </Section>

      <Section title="API Reference">
        <div className="space-y-3">
          <div>
            <p className="font-medium text-foreground mb-1">Base URL</p>
            <p><Code>https://api.apif.ai</Code> (production) or your staging URL</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">Authentication</p>
            <p>All requests require a Bearer token (JWT from login or an API key).</p>
            <pre className="bg-muted rounded-lg p-3 font-mono text-xs overflow-auto mt-1">Authorization: Bearer YOUR_TOKEN</pre>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">Endpoints</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs mt-1">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1.5 pr-4 font-medium text-foreground">Resource</th>
                    <th className="text-left py-1.5 font-medium text-foreground">Endpoints</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">Auth</td><td>POST /auth/login, /auth/register</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">APIs</td><td>GET/POST/PUT/DELETE /apis</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">Tools</td><td>GET/POST/PATCH/DELETE /tools</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">Gateways</td><td>GET/POST/PATCH/DELETE /gateways</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">Agents</td><td>GET/POST/PATCH/DELETE /agents</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">Invoke</td><td>POST /agents/:id/invoke</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">Stream</td><td>POST /agents/:id/stream</td></tr>
                  <tr className="border-b"><td className="py-1.5 pr-4 font-sans">OpenAI</td><td>POST /v1/chat/completions</td></tr>
                  <tr><td className="py-1.5 pr-4 font-sans">Models</td><td>GET /v1/models</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Tools">
        <div className="space-y-3">
          <p>
            Tools are the building blocks that agents and gateways consume. They can be auto-generated from API schemas or created manually.
          </p>
          <div>
            <p className="font-medium text-foreground mb-1">Tool Types</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong className="text-foreground">API Operation</strong> -- Auto-generated from OpenAPI, GraphQL, SOAP, or Protobuf schemas</li>
              <li><strong className="text-foreground">HTTP</strong> -- Custom HTTP request with configurable method, URL, headers, and body</li>
              <li><strong className="text-foreground">JavaScript</strong> -- Sandboxed JS function for data transformation and logic</li>
              <li><strong className="text-foreground">GraphQL</strong> -- Custom GraphQL query or mutation</li>
              <li><strong className="text-foreground">LLM</strong> -- AI-powered tool that uses an LLM to generate responses</li>
            </ul>
          </div>
          <p>
            Test any tool from its detail page using the "Execute" panel. View execution history, usage stats, and export as SKILL.md or SDK snippet.
          </p>
        </div>
      </Section>

      <Section title="Organizations & RBAC">
        <div className="space-y-3">
          <p>
            apifai supports multi-tenancy with organizations. Each organization has its own APIs, tools, gateways, and agents.
          </p>
          <div>
            <p className="font-medium text-foreground mb-1">Roles</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong className="text-foreground">Owner</strong> -- Full control, can delete the organization</li>
              <li><strong className="text-foreground">Admin</strong> -- Manage members, APIs, tools, gateways, and agents</li>
              <li><strong className="text-foreground">Member</strong> -- Create and manage their own resources</li>
              <li><strong className="text-foreground">Viewer</strong> -- Read-only access to all resources</li>
            </ul>
          </div>
          <p>
            Switch organizations using the dropdown in the sidebar. Manage members from Settings.
          </p>
        </div>
      </Section>
    </div>
  )
}
