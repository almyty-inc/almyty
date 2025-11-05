import React, { useEffect, useState } from 'react'
import { Activity, Zap, Database, Users, TrendingUp, AlertCircle } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'

interface ProtocolMetrics {
  mcp: {
    sessions: number;
    toolCalls: number;
    responseTime: number;
    errorRate: number;
  };
  utcp: {
    manuals: number;
    directCalls: number;
    proxyExecutions: number;
  };
  a2a: {
    activeAgents: number;
    messages: number;
    workflows: number;
  };
}

interface TransportStats {
  sse: {
    connections: number;
    averageAge: number;
    messagesPerSecond: number;
  };
  websocket: {
    connections: number;
    averageAge: number;
    messagesPerSecond: number;
  };
}

export function ProtocolMonitor() {
  const [metrics, setMetrics] = useState<ProtocolMetrics | null>(null)
  const [transportStats, setTransportStats] = useState<TransportStats | null>(null)
  const [isConnected, setIsConnected] = useState(false)

  // Real-time monitoring via SSE
  useEffect(() => {
    const eventSource = new EventSource('/api/mcp/sse')
    
    eventSource.onopen = () => {
      setIsConnected(true)
    }
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        
        if (data.type === 'metrics_update') {
          setMetrics(data.metrics)
        }
        
        if (data.type === 'transport_stats') {
          setTransportStats(data.stats)
        }
      } catch (error) {
        console.error('Failed to parse SSE message:', error)
      }
    }
    
    eventSource.onerror = () => {
      setIsConnected(false)
    }
    
    return () => {
      eventSource.close()
    }
  }, [])

  // Simulated real-time data for demo
  useEffect(() => {
    const interval = setInterval(() => {
      setMetrics({
        mcp: {
          sessions: Math.floor(Math.random() * 50) + 10,
          toolCalls: Math.floor(Math.random() * 1000) + 500,
          responseTime: Math.floor(Math.random() * 500) + 100,
          errorRate: Math.random() * 0.05,
        },
        utcp: {
          manuals: Math.floor(Math.random() * 20) + 5,
          directCalls: Math.floor(Math.random() * 200) + 50,
          proxyExecutions: Math.floor(Math.random() * 100) + 25,
        },
        a2a: {
          activeAgents: Math.floor(Math.random() * 10) + 2,
          messages: Math.floor(Math.random() * 500) + 100,
          workflows: Math.floor(Math.random() * 5) + 1,
        },
      })

      setTransportStats({
        sse: {
          connections: Math.floor(Math.random() * 20) + 5,
          averageAge: Math.floor(Math.random() * 300) + 60,
          messagesPerSecond: Math.random() * 10 + 2,
        },
        websocket: {
          connections: Math.floor(Math.random() * 15) + 3,
          averageAge: Math.floor(Math.random() * 600) + 120,
          messagesPerSecond: Math.random() * 15 + 5,
        },
      })
    }, 2000)

    return () => clearInterval(interval)
  }, [])

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-xs text-muted-foreground">
          {isConnected ? 'Real-time monitoring active' : 'Disconnected from monitoring'}
        </span>
      </div>

      {/* Protocol Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Database className="h-4 w-4 text-blue-500" />
              MCP Metrics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs">Active Sessions:</span>
              <span className="text-xs font-mono">{metrics?.mcp.sessions || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Tool Calls:</span>
              <span className="text-xs font-mono">{metrics?.mcp.toolCalls || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Avg Response:</span>
              <span className="text-xs font-mono">{metrics?.mcp.responseTime || 0}ms</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs">Error Rate:</span>
              <div className="flex items-center gap-1">
                <Progress 
                  value={(metrics?.mcp.errorRate || 0) * 100} 
                  className="w-12 h-1"
                />
                <span className="text-xs font-mono">
                  {((metrics?.mcp.errorRate || 0) * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-green-500" />
              UTCP Metrics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs">Active Manuals:</span>
              <span className="text-xs font-mono">{metrics?.utcp.manuals || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Direct Calls:</span>
              <span className="text-xs font-mono">{metrics?.utcp.directCalls || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Proxy Executions:</span>
              <span className="text-xs font-mono">{metrics?.utcp.proxyExecutions || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Direct vs Proxy Ratio:</span>
              <span className="text-xs font-mono">
                {metrics ? (metrics.utcp.directCalls / (metrics.utcp.proxyExecutions || 1)).toFixed(1) : 0}:1
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4 text-purple-500" />
              A2A Metrics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs">Active Agents:</span>
              <span className="text-xs font-mono">{metrics?.a2a.activeAgents || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Messages Sent:</span>
              <span className="text-xs font-mono">{metrics?.a2a.messages || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Active Workflows:</span>
              <span className="text-xs font-mono">{metrics?.a2a.workflows || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Avg Messages/Agent:</span>
              <span className="text-xs font-mono">
                {metrics ? Math.round((metrics.a2a.messages || 0) / (metrics.a2a.activeAgents || 1)) : 0}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Transport Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4" />
              SSE Transport
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs">Active Connections:</span>
              <Badge variant="outline">{transportStats?.sse.connections || 0}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Average Age:</span>
              <span className="text-xs font-mono">{transportStats?.sse.averageAge || 0}s</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Messages/sec:</span>
              <span className="text-xs font-mono">
                {(transportStats?.sse.messagesPerSecond || 0).toFixed(1)}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-1">
              <div 
                className="bg-blue-500 h-1 rounded-full transition-all duration-500"
                style={{ 
                  width: `${Math.min(((transportStats?.sse.messagesPerSecond || 0) / 20) * 100, 100)}%` 
                }}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="h-4 w-4" />
              WebSocket Transport
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-xs">Active Connections:</span>
              <Badge variant="outline">{transportStats?.websocket.connections || 0}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Average Age:</span>
              <span className="text-xs font-mono">{transportStats?.websocket.averageAge || 0}s</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs">Messages/sec:</span>
              <span className="text-xs font-mono">
                {(transportStats?.websocket.messagesPerSecond || 0).toFixed(1)}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-1">
              <div 
                className="bg-green-500 h-1 rounded-full transition-all duration-500"
                style={{ 
                  width: `${Math.min(((transportStats?.websocket.messagesPerSecond || 0) / 30) * 100, 100)}%` 
                }}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Performance Trends */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Real-time Performance Trends
          </CardTitle>
          <CardDescription>
            Live performance data across all protocols and transports
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <TrendingUp className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p>Real-time charts will appear here</p>
            <p className="text-xs mt-2">
              (Charts require Chart.js integration - showing live metrics above)
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}