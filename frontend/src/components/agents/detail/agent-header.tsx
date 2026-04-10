/**
 * Agent detail page header: breadcrumb, title, status badge,
 * and action buttons (export, duplicate, invoke, edit).
 */
import React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Pencil,
  Play,
  Download,
  Copy,
  ChevronRight,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { statusVariant } from './constants'
import type { Agent } from '@/types'

interface AgentHeaderProps {
  agent: Agent
  onExport: () => void
  onDuplicate: () => void
  onInvoke: () => void
}

export function AgentHeader({ agent, onExport, onDuplicate, onInvoke }: AgentHeaderProps) {
  const navigate = useNavigate()

  return (
    <>
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/agents" className="hover:text-foreground">Agents</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{agent.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Back to agents" onClick={() => navigate('/agents')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold">{agent.name}</h1>
              <Badge variant={statusVariant[agent.status] || 'secondary'}>{agent.status}</Badge>
            </div>
            {agent.description && (
              <p className="text-muted-foreground mt-0.5">{agent.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={onDuplicate}>
            <Copy className="h-4 w-4 mr-2" />
            Duplicate
          </Button>
          <Button variant="outline" onClick={onInvoke}>
            <Play className="h-4 w-4 mr-2" />
            Invoke
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
