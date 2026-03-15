import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { ArrowLeft, Router, Copy, Zap, Edit2, Settings, BookOpen, Check, Package, Shield } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

import { gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

// Form Schema
const editGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  endpoint: z.string().min(1, 'Endpoint is required').transform(val => {
    // Auto-add leading slash if missing
    return val.startsWith('/') ? val : `/${val}`;
  }),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'maintenance', 'error']),
})

type EditGatewayForm = z.infer<typeof editGatewaySchema>

function SecurityPolicyForm({ initialPolicy, onSave, isSaving }: {
  initialPolicy: any;
  onSave: (policy: any) => void;
  isSaving: boolean;
}) {
  const [allowedDomains, setAllowedDomains] = useState(initialPolicy?.allowedDomains?.join(', ') || '')
  const [blockedDomains, setBlockedDomains] = useState(initialPolicy?.blockedDomains?.join(', ') || '')
  const [allowedMethods, setAllowedMethods] = useState(initialPolicy?.allowedHttpMethods?.join(', ') || '')
  const [maxResponseSize, setMaxResponseSize] = useState(initialPolicy?.maxResponseSizeBytes?.toString() || '')
  const [requireHttps, setRequireHttps] = useState(initialPolicy?.requireHttps || false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const policy: any = {}
    if (allowedDomains.trim()) policy.allowedDomains = allowedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (blockedDomains.trim()) policy.blockedDomains = blockedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (allowedMethods.trim()) policy.allowedHttpMethods = allowedMethods.split(',').map((m: string) => m.trim().toUpperCase()).filter(Boolean)
    if (maxResponseSize.trim()) policy.maxResponseSizeBytes = parseInt(maxResponseSize, 10)
    policy.requireHttps = requireHttps
    onSave(Object.keys(policy).length > 1 || requireHttps ? policy : null)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="allowed-domains">Allowed Domains</Label>
        <Input
          id="allowed-domains"
          placeholder="api.example.com, cdn.example.com"
          value={allowedDomains}
          onChange={(e) => setAllowedDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated list of allowed target domains. Leave empty to allow all.</p>
      </div>
      <div>
        <Label htmlFor="blocked-domains">Blocked Domains</Label>
        <Input
          id="blocked-domains"
          placeholder="internal.corp, admin.example.com"
          value={blockedDomains}
          onChange={(e) => setBlockedDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated list of blocked domains.</p>
      </div>
      <div>
        <Label htmlFor="allowed-methods">Allowed HTTP Methods</Label>
        <Input
          id="allowed-methods"
          placeholder="GET, POST"
          value={allowedMethods}
          onChange={(e) => setAllowedMethods(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated. Leave empty to allow all methods.</p>
      </div>
      <div>
        <Label htmlFor="max-response-size">Max Response Size (bytes)</Label>
        <Input
          id="max-response-size"
          type="number"
          placeholder="10485760"
          value={maxResponseSize}
          onChange={(e) => setMaxResponseSize(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Maximum response body size. Default: 10MB.</p>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="require-https">Require HTTPS</Label>
          <p className="text-xs text-muted-foreground">Block HTTP requests, enforce HTTPS only</p>
        </div>
        <Switch id="require-https" checked={requireHttps} onCheckedChange={setRequireHttps} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Policy'}
        </Button>
      </div>
    </form>
  )
}

function IntegrationsSection({ gatewayId, gateway, orgSlug }: { gatewayId: string; gateway: any; orgSlug: string }) {
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
    } catch {}
  }

  const backendUrl = window.location.origin.replace(':3002', ':4000').replace(':8080', ':3000')
  const gatewayType = (gateway.type || 'mcp').toLowerCase()
  const skillsContent = skillsData?.data?.data || skillsData?.data || ''

  // Skills gateway
  if (gatewayType === 'skills') {
    const installCommand = `npx @apifai/skills install --gateway ${gatewayId}`
    const loginCommand = `npx @apifai/skills login`

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
              <Label className="text-sm font-medium">First-Time Setup</Label>
              <p className="text-xs text-muted-foreground mb-2">Authenticate once (or use APIFAI_TOKEN env var):</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{loginCommand}</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(loginCommand, 'login-cmd')}>
                  {copiedField === 'login-cmd' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Agent Directories</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {[
                  { agent: 'Claude Code', dir: '.claude/skills/' },
                  { agent: 'Cursor', dir: '.agents/skills/' },
                  { agent: 'Windsurf', dir: '.windsurf/skills/' },
                  { agent: 'Copilot / Codex', dir: '.agents/skills/' },
                ].map(({ agent, dir }) => (
                  <div key={agent} className="flex items-center gap-2 text-xs bg-muted/50 px-3 py-2 rounded">
                    <code className="font-mono text-purple-600 dark:text-purple-400">{dir}</code>
                    <span className="text-muted-foreground">({agent})</span>
                  </div>
                ))}
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
                ) : skillsContent ? (
                  <pre className="text-xs bg-muted p-3 rounded max-h-64 overflow-auto font-mono mt-2">
                    {typeof skillsContent === 'string' ? skillsContent.slice(0, 800) : JSON.stringify(skillsContent, null, 2).slice(0, 800)}
                    {(typeof skillsContent === 'string' ? skillsContent.length : JSON.stringify(skillsContent).length) > 800 ? '\n...' : ''}
                  </pre>
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
    const mcpEndpoint = `${backendUrl}/api/mcp/${orgSlug}${gateway.endpoint}`
    const sseEndpoint = `${backendUrl}/api/mcp/sse`
    const discoveryUrl = `${backendUrl}/api/mcp/.well-known/mcp`

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
            <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded">
              <strong>Auth:</strong> Include <code className="font-mono">Authorization: Bearer &lt;jwt&gt;</code> header.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // A2A gateway
  if (gatewayType === 'a2a') {
    const a2aBase = `${backendUrl}/api/a2a`
    const discoveryUrl = `${backendUrl}/a2a/.well-known/a2a`

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
            <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded">
              <strong>Auth:</strong> Include <code className="font-mono">Authorization: Bearer &lt;jwt&gt;</code> header. Discovery is public.
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // UTCP gateway
  if (gatewayType === 'utcp') {
    const discoveryUrl = `${backendUrl}/api/utcp/.well-known/utcp`
    const orgId = gateway.organizationId || orgSlug

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
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{backendUrl}/api/utcp/{orgId}/execute</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`${backendUrl}/api/utcp/${orgId}/execute`, 'utcp-execute')}>
                  {copiedField === 'utcp-execute' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Tool Manual</Label>
              <p className="text-xs text-muted-foreground mb-1">GET to retrieve the UTCP manual</p>
              <div className="flex gap-2 mt-1">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">{backendUrl}/api/utcp/{orgId}/manual</code>
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(`${backendUrl}/api/utcp/${orgId}/manual`, 'utcp-manual')}>
                  {copiedField === 'utcp-manual' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded">
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

function GatewayAuthSection({ gatewayId, gatewayName }: { gatewayId: string; gatewayName: string }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: ['gateway-api-keys', gatewayId],
    queryFn: () => gatewaysApi.listApiKeys(gatewayId),
    enabled: !!gatewayId,
  })

  const generateKeyMutation = useMutation({
    mutationFn: (name: string) => gatewaysApi.generateApiKey(gatewayId, { name }),
    onSuccess: (response: any) => {
      const key = response.data?.data?.key
      setGeneratedKey(key)
      queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
      success('API Key Generated', 'Copy and save it now — it will not be shown again.')
    },
    onError: () => {
      errorNotif('Failed to generate key', 'Could not generate API key')
    },
  })

  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: string) => gatewaysApi.revokeApiKey(gatewayId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
      success('Key Revoked', 'API key has been revoked')
    },
    onError: () => {
      errorNotif('Failed to revoke', 'Could not revoke API key')
    },
  })

  const keys = keysData?.data?.data || []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Authentication
            </CardTitle>
            <CardDescription>
              API keys for accessing this gateway. Clients must include a valid key in the <code className="text-xs bg-muted px-1 py-0.5 rounded">x-api-key</code> header.
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setNewKeyName('')
              setGeneratedKey(null)
              setCopied(false)
              setGenerateDialogOpen(true)
            }}
          >
            Generate API Key
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {keysLoading ? (
          <div className="flex justify-center py-4"><LoadingSpinner /></div>
        ) : keys.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            No API keys yet. Generate one to allow clients to access this gateway.
          </div>
        ) : (
          <div className="space-y-2">
            {keys.map((key: any) => (
              <div key={key.id} className="flex items-center justify-between px-3 py-2 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <code className="text-xs font-mono bg-background px-2 py-1 rounded">{key.keyPrefix}...</code>
                  <span className="text-sm font-medium">{key.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  {key.lastUsedAt && (
                    <span className="text-xs text-muted-foreground">
                      Last used {new Date(key.lastUsedAt).toLocaleDateString()}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => revokeKeyMutation.mutate(key.id)}
                    disabled={revokeKeyMutation.isPending}
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Generate Key Dialog */}
      <Dialog open={generateDialogOpen} onOpenChange={setGenerateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate API Key</DialogTitle>
            <DialogDescription>
              Create a new API key for {gatewayName}. The key will only be shown once.
            </DialogDescription>
          </DialogHeader>
          {generatedKey ? (
            <div className="space-y-4">
              <div>
                <Label>Your API Key</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={generatedKey} readOnly className="font-mono text-xs" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(generatedKey)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-destructive mt-2">
                  Save this key now. It will not be shown again.
                </p>
              </div>
              <Button className="w-full" onClick={() => setGenerateDialogOpen(false)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label>Key Name</Label>
                <Input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Production, CI/CD, Development"
                  className="mt-1"
                />
              </div>
              <Button
                className="w-full"
                onClick={() => generateKeyMutation.mutate(newKeyName || `${gatewayName} Key`)}
                disabled={generateKeyMutation.isPending}
              >
                {generateKeyMutation.isPending ? 'Generating...' : 'Generate Key'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()

  const [removeAllToolsDialogOpen, setRemoveAllToolsDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false)
  const [securityTarget, setSecurityTarget] = useState<{ gatewayToolId: string; toolName: string; policy: any } | null>(null)

  const { data: gatewayData, isLoading } = useQuery({
    queryKey: ['gateway', id],
    queryFn: () => gatewaysApi.getById(id!),
    enabled: !!id,
  })

  const { data: gatewayToolsData, isLoading: isLoadingGatewayTools } = useQuery({
    queryKey: ['gateway-tools', id],
    queryFn: () => gatewaysApi.getTools(id!),
    enabled: !!id,
  })

  const { data: allToolsData, isLoading: isLoadingAllTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const assignToolMutation = useMutation({
    mutationFn: ({ toolId }: { toolId: string }) =>
      gatewaysApi.assignTool(id!, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tool assigned', 'Tool has been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tool', err.response?.data?.message || 'Please try again.')
    },
  })

  const removeToolMutation = useMutation({
    mutationFn: ({ toolId }: { toolId: string }) =>
      gatewaysApi.removeTool(id!, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tool removed', 'Tool has been removed from the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tool', err.response?.data?.message || 'Please try again.')
    },
  })

  const bulkAssignToolsMutation = useMutation({
    mutationFn: ({ toolIds }: { toolIds: string[] }) =>
      gatewaysApi.bulkAssignTools(id!, toolIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tools assigned', 'Tools have been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tools', err.response?.data?.message || 'Please try again.')
    },
  })

  const removeAllToolsMutation = useMutation({
    mutationFn: () => gatewaysApi.removeAllTools(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('All tools removed', 'All tools have been removed from the gateway.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tools', err.response?.data?.message || 'Please try again.')
    },
  })

  // Edit form setup - must be before early returns
  const gateway = gatewayData?.data?.data || gatewayData?.data
  const editForm = useForm<EditGatewayForm>({
    resolver: zodResolver(editGatewaySchema),
    values: {
      name: gateway?.name || '',
      endpoint: gateway?.endpoint || '',
      description: gateway?.description || '',
      status: gateway?.status || 'active',
    }
  })

  // Edit gateway mutation
  const editGatewayMutation = useMutation({
    mutationFn: (data: EditGatewayForm) => gatewaysApi.update(id!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Gateway updated', 'Gateway has been updated successfully.')
      setEditDialogOpen(false)
    },
    onError: (err: any) => {
      errorNotif('Failed to update gateway', err.response?.data?.message || 'Please try again.')
    },
  })

  const updateToolConfigMutation = useMutation({
    mutationFn: ({ gatewayToolId, data }: { gatewayToolId: string; data: any }) =>
      gatewaysApi.updateToolConfig(id!, gatewayToolId, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      success('Security policy updated', 'Tool security policy has been saved.')
      setSecurityDialogOpen(false)
      setSecurityTarget(null)
    },
    onError: (err: any) => {
      errorNotif('Failed to update security policy', err.response?.data?.message || 'Please try again.')
    },
  })

  const gatewayToolsRaw = gatewayToolsData?.data?.data?.gatewayTools || gatewayToolsData?.data?.data?.tools || gatewayToolsData?.data?.data || []
  const gatewayTools = Array.isArray(gatewayToolsRaw) ? gatewayToolsRaw : []

  const allToolsRaw = allToolsData?.data?.data?.tools || allToolsData?.data?.data || []
  const allTools = Array.isArray(allToolsRaw) ? allToolsRaw : []

  const applyScopingPreset = (preset: 'read-only' | 'admin' | 'public' | 'all' | 'none') => {
    // Special case: 'none' should remove all tools
    if (preset === 'none') {
      removeAllToolsMutation.mutate()
      return
    }

    let toolsToAssign: string[] = []

    switch (preset) {
      case 'read-only':
        toolsToAssign = allTools
          .filter((tool: any) => tool.method === 'GET' || tool.name?.toLowerCase().includes('get'))
          .map((tool: any) => tool.id)
        break
      case 'admin':
        toolsToAssign = allTools
          .filter((tool: any) =>
            tool.name?.toLowerCase().includes('admin') ||
            tool.name?.toLowerCase().includes('delete') ||
            tool.name?.toLowerCase().includes('update')
          )
          .map((tool: any) => tool.id)
        break
      case 'public':
        toolsToAssign = allTools
          .filter((tool: any) =>
            !tool.name?.toLowerCase().includes('delete') &&
            !tool.name?.toLowerCase().includes('admin')
          )
          .map((tool: any) => tool.id)
        break
      case 'all':
        toolsToAssign = allTools.map((tool: any) => tool.id)
        break
    }

    bulkAssignToolsMutation.mutate({ toolIds: toolsToAssign })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!gatewayData?.data) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-muted-foreground">Gateway not found</p>
          <Button className="mt-4" onClick={() => navigate('/gateways')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Gateways
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/gateways')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <Router className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{gateway.name}</h1>
              <p className="text-muted-foreground">{gateway.description || 'API Gateway'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
            <Settings className="h-4 w-4 mr-2" />
            Edit Gateway
          </Button>
          <Badge variant={gateway.status === 'active' ? 'default' : 'secondary'}>
            {gateway.status}
          </Badge>
          <Badge variant="outline">
            {gateway.type?.toUpperCase()}
          </Badge>
        </div>
      </div>

      {/* Gateway Configuration — type-specific */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            {gateway.type === 'skills' ? 'Install command and setup' : 'Gateway endpoint and connection details'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-2">
                {gateway.type === 'mcp' && 'MCP Endpoint URL'}
                {gateway.type === 'utcp' && 'UTCP Manual URL'}
                {gateway.type === 'a2a' && 'A2A Discovery URL'}
                {gateway.type === 'skills' && 'Install Command'}
              </p>
              <div className="flex gap-2">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">
                  {(() => {
                    const backendUrl = window.location.origin.replace(':3002', ':4000').replace('app.', 'api.')
                    const orgSlug = currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
                    if (gateway.type === 'mcp') return `${backendUrl}/mcp/${orgSlug}${gateway.endpoint}`
                    if (gateway.type === 'utcp') return `${backendUrl}/utcp/${orgSlug}${gateway.endpoint}/manual`
                    if (gateway.type === 'a2a') return `${backendUrl}/a2a/${orgSlug}${gateway.endpoint}/.well-known/a2a`
                    if (gateway.type === 'skills') return `npx @apifai/skills install --gateway ${gateway.id}`
                    return gateway.endpoint
                  })()}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const backendUrl = window.location.origin.replace(':3002', ':4000').replace('app.', 'api.')
                    const orgSlug = currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
                    let fullEndpoint = gateway.endpoint
                    if (gateway.type === 'mcp') fullEndpoint = `${backendUrl}/mcp/${orgSlug}${gateway.endpoint}`
                    else if (gateway.type === 'utcp') fullEndpoint = `${backendUrl}/utcp/${orgSlug}${gateway.endpoint}/manual`
                    else if (gateway.type === 'a2a') fullEndpoint = `${backendUrl}/a2a/${orgSlug}${gateway.endpoint}/.well-known/a2a`
                    else if (gateway.type === 'skills') fullEndpoint = `npx @apifai/skills install --gateway ${gateway.id}`
                    try {
                      await navigator.clipboard.writeText(fullEndpoint)
                      success('Copied!', 'Endpoint copied to clipboard')
                    } catch (err) {
                      errorNotif('Failed to copy', 'Could not copy to clipboard')
                    }
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              {gateway.type !== 'skills' && (
                <p className="text-xs text-muted-foreground mt-1">
                  Path: <code className="bg-muted px-1 py-0.5 rounded text-xs">{gateway.endpoint}</code>
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Authentication */}
      {gateway.type !== 'skills' && (
        <GatewayAuthSection gatewayId={gateway.id} gatewayName={gateway.name} />
      )}

      {/* Main Content */}
      <Tabs defaultValue="tools" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tools">Tool Scoping ({gatewayTools.length}/{allTools.length})</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="space-y-6">
          {/* Scoping Status */}
          <Card>
            <CardHeader>
              <CardTitle>Tool Scoping</CardTitle>
              <CardDescription>
                Control which tools are available through this gateway. {gatewayTools.length} of {allTools.length} assigned
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('read-only')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Read Only
                </Button>
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('admin')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Admin Tools
                </Button>
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('public')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Public API
                </Button>
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('all')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  All Tools
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRemoveAllToolsDialogOpen(true)}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Remove All
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Available Tools */}
          {isLoadingGatewayTools || isLoadingAllTools ? (
            <div className="flex items-center justify-center h-64">
              <LoadingSpinner size="lg" />
            </div>
          ) : allTools.length === 0 ? (
            <Card>
              <CardContent className="text-center py-8">
                <Zap className="h-12 w-12 text-muted-foreground mx-auto mb-2" />
                <p className="text-muted-foreground">
                  No tools available. Create some tools from your APIs first.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {allTools.map((tool: any) => {
                const isAssigned = gatewayTools.some((gt: any) => gt.id === tool.id || gt.toolId === tool.id)

                return (
                  <Card key={tool.id}>
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex-1">
                        <div className="font-medium">{tool.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {tool.description || 'No description'}
                        </div>
                        {tool.method && (
                          <Badge variant="outline" className="mt-1">
                            {tool.method}
                          </Badge>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {isAssigned && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const gt = gatewayTools.find((gt: any) => gt.id === tool.id || gt.toolId === tool.id)
                              setSecurityTarget({
                                gatewayToolId: gt?.gatewayToolId || gt?.id || tool.id,
                                toolName: tool.name,
                                policy: gt?.securityPolicy || null,
                              })
                              setSecurityDialogOpen(true)
                            }}
                          >
                            <Shield className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant={isAssigned ? 'destructive' : 'default'}
                          size="sm"
                          onClick={() => {
                            if (isAssigned) {
                              removeToolMutation.mutate({ toolId: tool.id })
                            } else {
                              assignToolMutation.mutate({ toolId: tool.id })
                            }
                          }}
                          disabled={assignToolMutation.isPending || removeToolMutation.isPending}
                        >
                          {isAssigned ? 'Remove' : 'Assign'}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="metrics" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Performance Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-2xl font-bold">{gateway.totalRequests || 0}</div>
                    <div className="text-sm text-muted-foreground">Total Requests</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-green-600">
                      {gateway.successfulRequests || 0}
                    </div>
                    <div className="text-sm text-muted-foreground">Successful</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-red-600">
                      {gateway.failedRequests || 0}
                    </div>
                    <div className="text-sm text-muted-foreground">Failed</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold">{gatewayTools.length}</div>
                    <div className="text-sm text-muted-foreground">Assigned Tools</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integrations" className="space-y-6">
          <IntegrationsSection gatewayId={id!} gateway={gateway} orgSlug={currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'} />
        </TabsContent>
      </Tabs>

      {/* Edit Gateway Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Gateway</DialogTitle>
            <DialogDescription>
              Update gateway settings. Note: only the gateway type (MCP/A2A/UTCP) cannot be changed after creation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit((data) => editGatewayMutation.mutate(data))} className="space-y-6">
            <div>
              <Label htmlFor="edit-name">Gateway Name</Label>
              <Input
                id="edit-name"
                placeholder="Enter gateway name"
                {...editForm.register('name')}
              />
              {editForm.formState.errors.name && (
                <p className="text-sm text-red-500 mt-1">
                  {editForm.formState.errors.name.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Type: <Badge variant="outline" className="ml-1">{gateway.type?.toUpperCase()}</Badge> (cannot be changed)
              </p>
            </div>

            <div>
              <Label htmlFor="edit-endpoint">Endpoint Path</Label>
              <Input
                id="edit-endpoint"
                placeholder="my-gateway"
                {...editForm.register('endpoint')}
              />
              {editForm.formState.errors.endpoint && (
                <p className="text-sm text-red-500 mt-1">
                  {editForm.formState.errors.endpoint.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                The path for your gateway (slash is added automatically)
              </p>
            </div>

            <div>
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                placeholder="Enter gateway description"
                {...editForm.register('description')}
              />
            </div>

            <div>
              <Label htmlFor="edit-status">Status</Label>
              <Select
                onValueChange={(value) => editForm.setValue('status', value as any)}
                value={editForm.watch('status')}
              >
                <SelectTrigger id="edit-status">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={editGatewayMutation.isPending}
              >
                {editGatewayMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove All Tools Confirmation */}
      <AlertDialog open={removeAllToolsDialogOpen} onOpenChange={setRemoveAllToolsDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all tools?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all tools from the gateway. The gateway will not be able to serve any requests until tools are assigned again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                applyScopingPreset('none')
                setRemoveAllToolsDialogOpen(false)
              }}
            >
              Remove All Tools
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Security Policy Dialog */}
      <Dialog open={securityDialogOpen} onOpenChange={(open) => { setSecurityDialogOpen(open); if (!open) setSecurityTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Security Policy: {securityTarget?.toolName}
            </DialogTitle>
            <DialogDescription>
              Configure security constraints for this tool in the gateway.
            </DialogDescription>
          </DialogHeader>
          {securityTarget && (
            <SecurityPolicyForm
              initialPolicy={securityTarget.policy}
              onSave={(policy) => {
                updateToolConfigMutation.mutate({
                  gatewayToolId: securityTarget.gatewayToolId,
                  data: { securityPolicy: policy },
                })
              }}
              isSaving={updateToolConfigMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
