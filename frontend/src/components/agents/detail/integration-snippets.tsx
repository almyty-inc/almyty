/**
 * Integration code snippets panel (cURL, Python, Node.js)
 * showing how to invoke the agent programmatically.
 * NOTE: console.log lines inside template literals are intentional
 * user-facing code examples, not runtime debug logs.
 */
import React, { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { useOrganizationStore } from '@/store/organization'
import type { Agent } from '@/types'

interface IntegrationSnippetsProps {
  agent: Agent
}

export function IntegrationSnippets({ agent }: IntegrationSnippetsProps) {
  const [integrationTab, setIntegrationTab] = useState<'curl' | 'python' | 'node'>('curl')
  const { currentOrganization } = useOrganizationStore()

  const apiBase = window.location.origin.replace('app.', 'api.')
  const orgSlug = currentOrganization?.slug || currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
  const agentRef = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const unifiedUrl = `${apiBase}/${orgSlug}/${agentRef}`
  const snippets: Record<string, string> = {
    curl: `# Unified endpoint
curl -X POST ${unifiedUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Hello"}'

# OpenAI-compatible endpoint
curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"agent:${agentRef}","messages":[{"role":"user","content":"Hello"}]}'`,
    python: `import requests

# Unified endpoint
r = requests.post("${unifiedUrl}", json={"message": "Hello"})
print(r.json())

# Or use OpenAI-compatible endpoint
from openai import OpenAI

client = OpenAI(base_url="${apiBase}/v1", api_key="YOUR_API_KEY")
r = client.chat.completions.create(
    model="agent:${agentRef}",
    messages=[{"role": "user", "content": "Hello"}]
)
print(r.choices[0].message.content)`,
    node: `// Unified endpoint
const r = await fetch('${unifiedUrl}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Hello' }),
});
console.log(await r.json());

// Or use OpenAI-compatible endpoint
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${apiBase}/v1', apiKey: 'YOUR_API_KEY' });
const r2 = await client.chat.completions.create({
  model: 'agent:${agentRef}',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(r2.choices[0].message.content);`,
  }
  const langMap: Record<string, string> = { curl: 'bash', python: 'python', node: 'javascript' }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Integration</CardTitle>
          <div className="flex gap-1">
            {(['curl', 'python', 'node'] as const).map(tab => (
              <Button
                key={tab}
                variant={integrationTab === tab ? 'default' : 'ghost'}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => setIntegrationTab(tab)}
              >
                {tab === 'curl' ? 'cURL' : tab === 'python' ? 'Python' : 'Node.js'}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <CodeBlock
          value={snippets[integrationTab]}
          language={langMap[integrationTab]}
          maxHeight="180px"
        />
      </CardContent>
    </Card>
  )
}
