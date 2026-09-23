/**
 * Agent detail page header: breadcrumb, title, status badge,
 * and action buttons (export, duplicate, activate, run, edit).
 */
import React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Pencil,
  Play,
  Pause,
  Download,
  Copy,
  ChevronRight,
  FileText,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { statusVariant } from './constants'
import type { Agent } from '@/types'

interface AgentHeaderProps {
  agent: Agent
  onExport: () => void
  onExportTechDoc: () => void
  onDuplicate: () => void
  onInvoke: () => void
  onActivate: () => void
  onDeactivate: () => void
  activationDisabled?: boolean
}

export function AgentHeader({
  agent,
  onExport,
  onExportTechDoc,
  onDuplicate,
  onInvoke,
  onActivate,
  onDeactivate,
  activationDisabled = false,
}: AgentHeaderProps) {
  const navigate = useNavigate()

  return (
    <>
      {/* Breadcrumbs */}
      <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <Link to="/agents" className="shrink-0 hover:text-foreground">Agents</Link>
        <ChevronRight className="h-3 w-3 shrink-0" />
        <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{agent.name}</span>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-80 items-start gap-3">
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="Back to agents" onClick={() => navigate('/agents')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className={DETAIL_TITLE_CLASSES}>{agent.name}</h1>
              <Badge variant={statusVariant[agent.status] || 'secondary'}>
                {agent.status === 'active' ? 'Active' : agent.status === 'draft' ? 'Draft' : agent.status === 'inactive' ? 'Inactive' : agent.status}
              </Badge>
            </div>
            {agent.description && (
              <p className="text-muted-foreground mt-0.5 [overflow-wrap:anywhere]">{agent.description}</p>
            )}
          </div>
        </div>
        <div role="group" aria-label="Agent actions" className="flex max-w-full flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onExportTechDoc}
            title="Export EU AI Act style technical documentation (Markdown)"
          >
            <FileText className="h-4 w-4 mr-2" />
            Tech doc
          </Button>
          <Button variant="outline" size="sm" onClick={onDuplicate}>
            <Copy className="h-4 w-4 mr-2" />
            Duplicate
          </Button>
          {agent.status === 'active' ? (
            <Button variant="outline" size="sm" onClick={onDeactivate}>
              <Pause className="h-4 w-4 mr-2" />
              Deactivate
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onActivate} disabled={activationDisabled}>
              Activate
            </Button>
          )}
          <Button variant="outline" onClick={onInvoke}>
            <Play className="h-4 w-4 mr-2" />
            Run
          </Button>
          <Button onClick={() => navigate(`/agents/${agent.id}/edit`)}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </div>
      </div>
    </>
  )
}
