import React, { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  ArrowDownToLine,
  Bot,
  DollarSign,
  Globe,
  MessageSquare,
  Receipt,
  Route,
  ScrollText,
  Wallet,
  Wrench,
  Zap,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { analyticsApi } from '@/lib/api'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/layout/page-header'

import {
  type AnalyticsTab,
  getAnalyticsTab,
} from '@/components/analytics/constants'
import { AgentsTab } from '@/components/analytics/agents-tab'
import { AuditTab } from '@/components/analytics/audit-tab'
import { CostTab } from '@/components/analytics/cost-tab'
import { BudgetsTab } from '@/components/analytics/budgets-tab'
import { GatewaysTab } from '@/components/analytics/gateways-tab'
import { LlmTab } from '@/components/analytics/llm-tab'
import { OverviewTab } from '@/components/analytics/overview-tab'
import { RequestLogTab } from '@/components/analytics/request-log-tab'
import { RoutingTab } from '@/components/analytics/routing-tab'
import { ChargebackTab } from '@/components/analytics/chargeback-tab'
import { ToolsTab } from '@/components/analytics/tools-tab'

const TAB_DEFINITIONS: Array<{
  key: AnalyticsTab
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'requests', label: 'Request log', icon: Globe },
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'gateways', label: 'Gateways', icon: Zap },
  { key: 'llm', label: 'Models', icon: MessageSquare },
  { key: 'routing', label: 'Routing', icon: Route },
  { key: 'agents', label: 'Agents', icon: Bot },
  { key: 'cost', label: 'Cost', icon: DollarSign },
  { key: 'budgets', label: 'Budgets', icon: Wallet },
  { key: 'chargeback', label: 'Chargeback', icon: Receipt },
  { key: 'audit', label: 'Audit trail', icon: ScrollText },
]

export function AnalyticsPage() {
  const { error } = useNotifications()
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
      // A click that produces no file and no message is indistinguishable
      // from a click that did not register.
      error('Export failed', getApiErrorMessage(err, 'The export could not be produced.'))
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Real-time usage data across all protocols"
        actions={
          <>
            <Button variant="outline" onClick={() => handleExport('requests', 'csv')}>
              <ArrowDownToLine className="h-4 w-4 mr-2" /> Export CSV
            </Button>
            <Button variant="outline" onClick={() => handleExport('requests', 'json')}>
              <ArrowDownToLine className="h-4 w-4 mr-2" /> Export JSON
            </Button>
          </>
        }
      />

      {/* Tabs — shared pill primitive, consistent with every other module */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as AnalyticsTab)}>
        <TabsList className="h-auto flex-wrap justify-start">
          {TAB_DEFINITIONS.map(({ key, label, icon: Icon }) => (
            <TabsTrigger key={key} value={key} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'requests' && <RequestLogTab />}
      {tab === 'tools' && <ToolsTab />}
      {tab === 'gateways' && <GatewaysTab />}
      {tab === 'llm' && <LlmTab />}
      {tab === 'routing' && <RoutingTab />}
      {tab === 'chargeback' && <ChargebackTab />}
      {tab === 'agents' && <AgentsTab />}
      {tab === 'cost' && <CostTab />}
      {tab === 'budgets' && <BudgetsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  )
}
