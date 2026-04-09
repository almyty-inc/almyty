import React, { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  ArrowDownToLine,
  Bot,
  Globe,
  MessageSquare,
  ScrollText,
  Wrench,
  Zap,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { analyticsApi } from '@/lib/api'
import { cn } from '@/lib/utils'

import {
  type AnalyticsTab,
  getAnalyticsTab,
} from '@/components/analytics/constants'
import { AgentsTab } from '@/components/analytics/agents-tab'
import { AuditTab } from '@/components/analytics/audit-tab'
import { GatewaysTab } from '@/components/analytics/gateways-tab'
import { LlmTab } from '@/components/analytics/llm-tab'
import { OverviewTab } from '@/components/analytics/overview-tab'
import { RequestLogTab } from '@/components/analytics/request-log-tab'
import { ToolsTab } from '@/components/analytics/tools-tab'

const TAB_DEFINITIONS: Array<{
  key: AnalyticsTab
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'requests', label: 'Request Log', icon: Globe },
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'gateways', label: 'Gateways', icon: Zap },
  { key: 'llm', label: 'LLM', icon: MessageSquare },
  { key: 'agents', label: 'Agents', icon: Bot },
  { key: 'audit', label: 'Audit Trail', icon: ScrollText },
]

export function AnalyticsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const tab = getAnalyticsTab(location.pathname)
  const setTab = (t: AnalyticsTab) =>
    navigate(t === 'overview' ? '/analytics' : `/analytics/${t}`)

  useEffect(() => {
    document.title = 'Analytics | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const handleExport = async (type: string, format: string) => {
    try {
      const res = await analyticsApi.exportData(format, type)
      const blob = new Blob(
        [typeof res === 'string' ? res : JSON.stringify(res, null, 2)],
        {
          type: format === 'csv' ? 'text/csv' : 'application/json',
        },
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${type}-${new Date().toISOString().split('T')[0]}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between pb-4 border-b">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            Analytics
          </h1>
          <p className="text-muted-foreground">Real-time usage data across all protocols</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleExport('requests', 'csv')}>
            <ArrowDownToLine className="h-4 w-4 mr-1" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport('requests', 'json')}>
            <ArrowDownToLine className="h-4 w-4 mr-1" /> Export JSON
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        {TAB_DEFINITIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'requests' && <RequestLogTab />}
      {tab === 'tools' && <ToolsTab />}
      {tab === 'gateways' && <GatewaysTab />}
      {tab === 'llm' && <LlmTab />}
      {tab === 'agents' && <AgentsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  )
}
