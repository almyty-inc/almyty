/* Global ⌘K / Ctrl+K command palette.
 *
 * Two kinds of entries:
 *   1. Navigation  — every top-level sidebar item routes here.
 *   2. Quick actions — "Create Agent", "Create Gateway", etc.
 *      These are just navigation entries with a verb prefix; the
 *      individual list pages already pop their own create dialogs
 *      when hit with `?new=1`, `/new`, or the `+` button. The
 *      simplest usable version routes to the list page and lets
 *      the user click through; adding deep-link query params later
 *      is an iterative polish.
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
    { id: 'nav-agents', label: 'Agents', icon: Bot, action: () => go('/agents'), keywords: ['pipeline', 'workflow'] },
    { id: 'nav-gateways', label: 'Gateways', icon: Zap, action: () => go('/gateways'), keywords: ['mcp', 'a2a', 'utcp', 'skills'] },
    { id: 'nav-tools', label: 'Tools', icon: Wrench, action: () => go('/tools'), keywords: ['http', 'javascript', 'graphql', 'llm', 'sdk'] },
    { id: 'nav-tool-hub', label: 'Tool Hub', icon: Store, action: () => go('/tool-hub'), keywords: ['templates', 'catalog'] },
    { id: 'nav-apis', label: 'APIs', icon: Globe, action: () => go('/apis'), keywords: ['openapi', 'graphql', 'soap', 'protobuf', 'sdk'] },
    { id: 'nav-credentials', label: 'Credentials', icon: Key, action: () => go('/credentials'), keywords: ['vault', 'secrets', 'access keys'] },
    { id: 'nav-llm-providers', label: 'Models', icon: Brain, action: () => go('/llm-providers'), keywords: ['openai', 'anthropic', 'claude', 'gpt'] },
    { id: 'nav-memories', label: 'Memory', icon: Database, action: () => go('/memories'), keywords: ['facts', 'preferences'] },
    { id: 'nav-chat', label: 'Chat', icon: MessageSquare, action: () => go('/chat'), keywords: ['conversation'] },
    { id: 'nav-analytics', label: 'Analytics', icon: BarChart3, action: () => go('/analytics'), keywords: ['metrics', 'usage', 'audit', 'requests', 'logs'] },
    { id: 'nav-organizations', label: 'Organizations', icon: Building, action: () => go('/organizations'), keywords: ['teams', 'members', 'orgs'] },
    { id: 'nav-settings', label: 'Settings', icon: Settings, action: () => go('/settings'), keywords: ['profile', 'account', 'security'] },
  ]

  const actionEntries: Entry[] = [
    { id: 'act-new-agent', label: 'Create Agent', hint: 'Open the visual agent builder', icon: Plus, action: () => go('/agents/new') },
    { id: 'act-new-gateway', label: 'Create Gateway', hint: 'MCP, A2A, UTCP, or Skills', icon: Plus, action: () => go('/gateways?new=1') },
    { id: 'act-new-tool', label: 'Create Tool', hint: 'HTTP, JavaScript, GraphQL, LLM, or SDK', icon: Plus, action: () => go('/tools?new=1') },
    { id: 'act-new-api', label: 'Import API', hint: 'OpenAPI, GraphQL, SOAP, Protobuf, SDK', icon: Plus, action: () => go('/apis?new=1') },
    { id: 'act-new-provider', label: 'Add LLM Provider', hint: 'OpenAI, Anthropic, Gemini, etc.', icon: Plus, action: () => go('/llm-providers?new=1') },
    { id: 'act-new-credential', label: 'Add Credential', hint: 'Store a vault secret', icon: Plus, action: () => go('/credentials?new=1') },
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
