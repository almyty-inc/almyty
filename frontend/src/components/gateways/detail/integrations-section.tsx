/**
 * IntegrationsSection — type-aware integration instructions for a gateway.
 *
 * Renders endpoint URLs, copy-paste configs (Claude Code, Cursor/Windsurf), and
 * Skills CLI commands depending on gateway type (mcp / a2a / utcp / skills).
 * Used by GatewayDetailPage's "Integrations" tab.
 */
import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Check, Copy, Router } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { gatewaysApi } from '@/lib/api'

export interface IntegrationsSectionProps {
  gatewayId: string
  gateway: any
  orgSlug: string
}

export function IntegrationsSection({ gatewayId, gateway, orgSlug }: IntegrationsSectionProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [showSkillPreview, setShowSkillPreview] = useState(false)

  const { data: skillsData, isLoading: skillsLoading } = useQuery({
    queryKey: ['gateway-skills', gatewayId],
    queryFn: () => gatewaysApi.getSkills(gatewayId),
    enabled: (gateway.type || '').toLowerCase() === 'skills',
  })

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch (err) {
      // Previously this catch was silent, so users clicking "Copy"
      // would see no feedback whatsoever when the browser blocked the
      // clipboard API (missing permission, insecure context, etc.).
      // Surface it as a copy-failure state and log once for debugging.
      console.warn('Clipboard copy failed:', err)
      setCopiedField(`${field}:error`)
      setTimeout(() => setCopiedField(null), 2500)
    }
  }

  const backendUrl = import.meta.env.VITE_API_BASE_URL || window.location.origin
  const gatewayType = (gateway.type || 'mcp').toLowerCase()
  const skillsContent = skillsData || ''

  // Skills gateway
  if (gatewayType === 'skills') {
    const gatewaySlug = (gateway.name || '').toLowerCase().replace(/\s+/g, '-')
    const installCommand = `npx @almyty/skills install @${orgSlug}/${gatewaySlug}`
    const watchCommand = `npx @almyty/skills watch @${orgSlug}/${gatewaySlug}`
    const loginCommand = `npx @almyty/auth login`

    // Extract the actual SKILL.md markdown content
    const skillMarkdown = (() => {
      if (!skillsContent) return ''
      if (typeof skillsContent === 'string') return skillsContent
      if (skillsContent.content) return skillsContent.content
      return ''
    })()

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-purple-500" />
              Skills Installation
            </CardTitle>
            <CardDescription>
              Install SKILL.md files into your AI coding agent's skill directory.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <Label className="text-sm font-medium">Install</Label>
              <p className="text-xs text-muted-foreground mb-2">Run in your project root:</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{installCommand}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(installCommand, 'install-cmd')}>
                  {copiedField === 'install-cmd' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Watch (daemon mode)</Label>
              <p className="text-xs text-muted-foreground mb-2">Auto-sync skills when tools change:</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{watchCommand}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(watchCommand, 'watch-cmd')}>
                  {copiedField === 'watch-cmd' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">First-Time Setup</Label>
              <p className="text-xs text-muted-foreground mb-2">Authenticate once (or use ALMYTY_TOKEN env var):</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{loginCommand}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(loginCommand, 'login-cmd')}>
                  {copiedField === 'login-cmd' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">SKILL.md Preview</Label>
                <Button size="sm" variant="ghost" onClick={() => setShowSkillPreview(!showSkillPreview)}>
                  {showSkillPreview ? 'Hide' : 'Show'}
                </Button>
              </div>
              {showSkillPreview && (
                skillsLoading ? (
                  <div className="flex justify-center py-4"><LoadingSpinner /></div>
                ) : skillMarkdown ? (
                  <div className="mt-2">
                    <CodeBlock
                      value={skillMarkdown.slice(0, 2000) + (skillMarkdown.length > 2000 ? '\n...' : '')}
                      language="text"
                      maxHeight="320px"
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4">No skills generated yet. Assign tools first.</p>
                )
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // MCP gateway
  if (gatewayType === 'mcp') {
    const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
    const mcpEndpoint = `${backendUrl}/${orgSlug}/${gwSlug}`
    const sseEndpoint = `${mcpEndpoint}/sse`
    const discoveryUrl = `${mcpEndpoint}/.well-known/mcp`

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Router className="h-5 w-5 text-orange-500" />
              MCP Endpoint
            </CardTitle>
            <CardDescription>JSON-RPC 2.0 protocol for AI agent tool access</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium">JSON-RPC Endpoint</Label>
              <p className="text-xs text-muted-foreground mb-1">POST with JSON-RPC 2.0 payloads</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{mcpEndpoint}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(mcpEndpoint, 'mcp-endpoint')}>
                  {copiedField === 'mcp-endpoint' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">SSE Transport</Label>
              <p className="text-xs text-muted-foreground mb-1">Server-Sent Events for streaming</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{sseEndpoint}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(sseEndpoint, 'sse-endpoint')}>
                  {copiedField === 'sse-endpoint' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Discovery</Label>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{discoveryUrl}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(discoveryUrl, 'discovery')}>
                  {copiedField === 'discovery' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground bg-muted p-3 rounded">
              <strong>Auth:</strong> {gateway.authConfigs?.length > 0
                ? <>Include <code className="font-mono">x-api-key: &lt;your-key&gt;</code> header. Generate keys in the Authentication section above.</>
                : <>Include <code className="font-mono">Authorization: Bearer &lt;jwt&gt;</code> header.</>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Setup</CardTitle>
            <CardDescription>Copy-paste configs for popular MCP clients</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Claude Desktop</h4>
              <p className="text-xs text-muted-foreground">Paste into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.</p>
              <CodeBlock
                value={JSON.stringify({
                  mcpServers: {
                    [(gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-')]: {
                      url: mcpEndpoint
                    }
                  }
                }, null, 2)}
                language="json"
                maxHeight="160px"
              />
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">Claude Code</h4>
              <p className="text-xs text-muted-foreground">Run in your terminal:</p>
              <div className="flex gap-2">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">claude mcp add {(gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-')} --transport http {mcpEndpoint}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`claude mcp add ${(gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-')} --transport http ${mcpEndpoint}`, 'claude-code-cmd')}>
                  {copiedField === 'claude-code-cmd' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">Cursor / Windsurf / VS Code</h4>
              <CodeBlock
                value={JSON.stringify({
                  mcpServers: {
                    [(gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-')]: {
                      url: mcpEndpoint
                    }
                  }
                }, null, 2)}
                language="json"
                maxHeight="160px"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // A2A gateway
  if (gatewayType === 'a2a') {
    const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
    const a2aBase = `${backendUrl}/${orgSlug}/${gwSlug}`
    const discoveryUrl = `${backendUrl}/${orgSlug}/${gwSlug}/.well-known/a2a`

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Router className="h-5 w-5 text-orange-500" />
              A2A Endpoints
            </CardTitle>
            <CardDescription>Agent-to-Agent protocol for inter-agent communication</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium">Discovery (public)</Label>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{discoveryUrl}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(discoveryUrl, 'a2a-discovery')}>
                  {copiedField === 'a2a-discovery' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Agent Registration</Label>
              <p className="text-xs text-muted-foreground mb-1">POST to register, GET to list</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{a2aBase}/agents</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`${a2aBase}/agents`, 'a2a-agents')}>
                  {copiedField === 'a2a-agents' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Messaging</Label>
              <p className="text-xs text-muted-foreground mb-1">POST to send messages between agents</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{a2aBase}/messages</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`${a2aBase}/messages`, 'a2a-messages')}>
                  {copiedField === 'a2a-messages' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground bg-muted p-3 rounded">
              <strong>Auth:</strong> Include <code className="font-mono">Authorization: Bearer &lt;jwt&gt;</code> header. Discovery is public.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ACP gateway
  if (gatewayType === 'acp') {
    const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
    const acpBase = `${backendUrl}/${orgSlug}/${gwSlug}`
    const discoveryUrl = `${backendUrl}/${orgSlug}/${gwSlug}/.well-known/acp`
    const acpServerCmd = `npx @almyty/acp-server --url ${acpBase}`

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Router className="h-5 w-5 text-amber-500" />
              ACP Endpoints
            </CardTitle>
            <CardDescription>Agent Communication Protocol for session-based agent interactions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium">JSON-RPC Endpoint</Label>
              <p className="text-xs text-muted-foreground mb-1">POST with JSON-RPC 2.0 payloads (initialize, session/new, session/prompt, etc.)</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{acpBase}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(acpBase, 'acp-endpoint')}>
                  {copiedField === 'acp-endpoint' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Discovery</Label>
              <p className="text-xs text-muted-foreground mb-1">GET to retrieve agent capabilities, auth methods, and skills</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{discoveryUrl}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(discoveryUrl, 'acp-discovery')}>
                  {copiedField === 'acp-discovery' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground bg-muted p-3 rounded">
              <strong>Auth:</strong> Include <code className="font-mono">Authorization: Bearer &lt;jwt&gt;</code> header. Discovery is public.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Setup</CardTitle>
            <CardDescription>Connect to this ACP gateway from your IDE or agent</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Zed</h4>
              <p className="text-xs text-muted-foreground">Add to your Zed settings.json:</p>
              <CodeBlock
                value={JSON.stringify({
                  agent: {
                    providers: {
                      [(gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-')]: {
                        url: acpBase,
                        protocol: 'acp',
                      }
                    }
                  }
                }, null, 2)}
                language="json"
                maxHeight="160px"
              />
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">JetBrains</h4>
              <p className="text-xs text-muted-foreground">Add to your IDE agent configuration:</p>
              <CodeBlock
                value={JSON.stringify({
                  agents: [{
                    name: (gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-'),
                    url: acpBase,
                    protocol: 'acp',
                  }]
                }, null, 2)}
                language="json"
                maxHeight="160px"
              />
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">ACP Server (CLI)</h4>
              <p className="text-xs text-muted-foreground">Run in your terminal:</p>
              <div className="flex gap-2">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{acpServerCmd}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(acpServerCmd, 'acp-server-cmd')}>
                  {copiedField === 'acp-server-cmd' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // UTCP gateway
  if (gatewayType === 'utcp') {
    const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
    const utcpBase = `${backendUrl}/${orgSlug}/${gwSlug}`
    const discoveryUrl = `${utcpBase}/.well-known/utcp`

    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Router className="h-5 w-5 text-orange-500" />
              UTCP Endpoints
            </CardTitle>
            <CardDescription>Universal Tool Call Protocol — REST-based tool execution</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium">Discovery (public)</Label>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{discoveryUrl}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(discoveryUrl, 'utcp-discovery')}>
                  {copiedField === 'utcp-discovery' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Execute Tool</Label>
              <p className="text-xs text-muted-foreground mb-1">POST to execute a tool via UTCP</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{utcpBase}/execute</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`${utcpBase}/execute`, 'utcp-execute')}>
                  {copiedField === 'utcp-execute' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Tool Manual</Label>
              <p className="text-xs text-muted-foreground mb-1">GET to retrieve the UTCP manual</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{utcpBase}/manual</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`${utcpBase}/manual`, 'utcp-manual')}>
                  {copiedField === 'utcp-manual' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground bg-muted p-3 rounded">
              <strong>Auth:</strong> Include <code className="font-mono">Authorization: Bearer &lt;jwt&gt;</code> header. Discovery is public.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Fallback
  return (
    <div className="text-sm text-muted-foreground py-8 text-center">
      No integration instructions available for gateway type "{gatewayType}".
    </div>
  )
}
