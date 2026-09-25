/* Global ⌘K / Ctrl+K command palette.
 *
 * Two kinds of entries:
 *   1. Navigation  — every top-level sidebar item routes here.
 *   2. Quick actions — "Create agent", "Create gateway", etc.
 *      Each one goes straight to that flow's own page (/gateways/new,
 *      /tools/new, ...). Create flows are pages, not dialogs.
 *
 * The palette is mounted once at the root of DashboardLayout.
 * A global keydown listener on ⌘K / Ctrl+K toggles the dialog.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Bot,
  Zap,
  Wrench,
  Globe,
  Key,
  Brain,
  Database,
  BarChart3,
  Settings,
  MessageSquare,
  Building,
  Plus,
  Store,
  ArrowRight,
  Cpu,
  FolderGit2,
  Package,
  Shield,
  BookOpen,
  Compass,
  Keyboard,
} from 'lucide-react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

interface Entry {
  id: string
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  action: () => void
  keywords?: string[]
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Also close on Escape even when the user is mid-typing in
      // the input (cmdk handles Escape from INSIDE the input, but
      // toggle from anywhere else needs this listener).
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const go = useCallback(
    (path: string) => {
      setOpen(false)
      navigate(path)
    },
    [navigate],
  )

  const navigationEntries: Entry[] = [
    { id: 'nav-dashboard', label: 'Dashboard', icon: LayoutDashboard, action: () => go('/dashboard'), keywords: ['home'] },
    { id: 'nav-guide', label: 'Guide', icon: Compass, action: () => go('/guide'), keywords: ['getting started', 'onboarding', 'setup', 'help', 'tour'] },
    { id: 'nav-agents', label: 'Agents', icon: Bot, action: () => go('/agents'), keywords: ['pipeline', 'workflow'] },
    { id: 'nav-gateways', label: 'Gateways', icon: Zap, action: () => go('/gateways'), keywords: ['mcp', 'a2a', 'utcp', 'skills'] },
    { id: 'nav-tools', label: 'Tools', icon: Wrench, action: () => go('/tools'), keywords: ['http', 'javascript', 'graphql', 'llm', 'sdk'] },
    { id: 'nav-tool-hub', label: 'Tool Hub', icon: Store, action: () => go('/tool-hub'), keywords: ['templates', 'catalog'] },
    { id: 'nav-apis', label: 'APIs', icon: Globe, action: () => go('/apis'), keywords: ['openapi', 'graphql', 'soap', 'protobuf', 'sdk'] },
    { id: 'nav-runners', label: 'Runners', icon: Cpu, action: () => go('/runners'), keywords: ['machine', 'daemon', 'execution', 'fleet'] },
    { id: 'nav-workspaces', label: 'Workspaces', icon: FolderGit2, action: () => go('/workspaces'), keywords: ['checkout', 'sandbox', 'runner'] },
    { id: 'nav-apps', label: 'Apps', icon: Package, action: () => go('/apps'), keywords: ['factory', 'build', 'distribution', 'desktop', 'binary'] },
    { id: 'nav-approvals', label: 'Approvals', icon: Shield, action: () => go('/approvals'), keywords: ['review', 'pending', 'gate'] },
    { id: 'nav-credentials', label: 'Credentials', icon: Key, action: () => go('/credentials'), keywords: ['vault', 'secrets', 'access keys'] },
    { id: 'nav-llm-providers', label: 'Models', icon: Brain, action: () => go('/models'), keywords: ['openai', 'anthropic', 'claude', 'gpt', 'catalog', 'routing', 'provider', 'api key', 'custom', 'ollama'] },
    { id: 'nav-memories', label: 'Memory', icon: Database, action: () => go('/memories'), keywords: ['facts', 'preferences'] },
    { id: 'nav-chat', label: 'Chat', icon: MessageSquare, action: () => go('/chat'), keywords: ['conversation'] },
    { id: 'nav-analytics', label: 'Analytics', icon: BarChart3, action: () => go('/analytics'), keywords: ['metrics', 'usage', 'audit', 'requests', 'logs'] },
    { id: 'nav-organizations', label: 'Organizations', icon: Building, action: () => go('/organizations'), keywords: ['teams', 'members', 'orgs'] },
    { id: 'nav-docs', label: 'Docs', icon: BookOpen, action: () => go('/docs'), keywords: ['help', 'guide', 'reference'] },
    { id: 'nav-shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, action: () => go('/shortcuts'), keywords: ['keys', 'hotkeys', 'help'] },
    { id: 'nav-settings', label: 'Settings', icon: Settings, action: () => go('/settings'), keywords: ['profile', 'account', 'security'] },
  ]

  const actionEntries: Entry[] = [
    { id: 'act-new-agent', label: 'Create agent', hint: 'Open the visual agent builder', icon: Plus, action: () => go('/agents/new') },
    { id: 'act-import-agent', label: 'Import agent', hint: 'From an exported agent JSON', icon: Plus, action: () => go('/agents/import') },
    { id: 'act-new-gateway', label: 'Create gateway', hint: 'MCP, A2A, UTCP, or Skills', icon: Plus, action: () => go('/gateways/new') },
    { id: 'act-new-app', label: 'Create app', hint: 'Ship an agent to web, desktop, or a chat platform', icon: Plus, action: () => go('/apps/new') },
    { id: 'act-new-tool', label: 'Create tool', hint: 'HTTP, JavaScript, GraphQL, Model, or SDK', icon: Plus, action: () => go('/tools/new') },
    { id: 'act-new-mcp-server', label: 'Add MCP server', hint: 'Use the tools of a remote MCP server', icon: Plus, action: () => go('/tools/mcp-servers/new') },
    { id: 'act-new-api', label: 'Connect API', hint: 'OpenAPI, GraphQL, SOAP, Protobuf, SDK', icon: Plus, action: () => go('/apis/new') },
    { id: 'act-connect-provider', label: 'Connect a provider', hint: 'OpenAI, Anthropic, Gemini, your own server', icon: Plus, action: () => go('/models/connect') },
    { id: 'act-new-runner', label: 'Register runner', hint: 'Run agents on your own machine', icon: Plus, action: () => go('/runners/new') },
    { id: 'act-new-credential', label: 'Add credential', hint: 'Store a vault secret', icon: Plus, action: () => go('/credentials/new') },
    { id: 'act-new-access-key', label: 'Generate access key', hint: 'For the CLI and the API', icon: Plus, action: () => go('/credentials/access-keys/new') },
    { id: 'act-connect-account', label: 'Connect an account', hint: 'OAuth or an API key, kept in one place', icon: Plus, action: () => go('/settings/connections/connect') },
    { id: 'act-new-custom-connector', label: 'Add custom connector', hint: 'Any service that takes a key or OAuth', icon: Plus, action: () => go('/settings/connections/custom/new') },
    { id: 'act-new-connection-policy', label: 'Add connection policy', hint: 'Govern who may use which connection', icon: Plus, action: () => go('/settings/connections/policies/new') },
    { id: 'act-new-approval-policy', label: 'Add approval policy', hint: 'Require a human to approve an action', icon: Plus, action: () => go('/settings/approvals/policies/new') },
    { id: 'act-new-memory', label: 'Add memory', hint: 'A fact or preference agents can recall', icon: Plus, action: () => go('/memories/new') },
    { id: 'act-transfer-memory', label: 'Transfer memory', hint: 'Move memories between backends', icon: Plus, action: () => go('/memories/transfer') },
    { id: 'act-new-budget', label: 'Add spend budget', hint: 'Cap what a team or agent can spend', icon: Plus, action: () => go('/analytics/budgets/new') },
    { id: 'act-new-organization', label: 'Create organization', hint: 'A separate workspace with its own members', icon: Plus, action: () => go('/organizations/new') },
  ]

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to… or run an action" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {navigationEntries.map((entry) => (
            <CommandItem
              key={entry.id}
              value={`${entry.label} ${(entry.keywords || []).join(' ')}`}
              onSelect={entry.action}
            >
              <entry.icon className="h-4 w-4 text-muted-foreground" />
              <span>{entry.label}</span>
              <ArrowRight className="ml-auto h-3 w-3 text-muted-foreground opacity-0 group-aria-selected:opacity-100" />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          {actionEntries.map((entry) => (
            <CommandItem key={entry.id} value={entry.label} onSelect={entry.action}>
              <entry.icon className="h-4 w-4 text-muted-foreground" />
              <span>{entry.label}</span>
              {entry.hint && (
                <span className="ml-auto text-xs text-muted-foreground">{entry.hint}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
