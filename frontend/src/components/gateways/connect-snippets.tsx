import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyField } from '@/components/ui/copy-field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ACCESS_KEY_PLACEHOLDER,
  mcpEndpointFor,
  sharedToolsSnippets,
  type ConnectableGateway,
} from '@/lib/gateway-connect'

/**
 * "Connect a client": the one address, and what to paste into each client
 * to use it. The snippets come from lib/gateway-connect.ts, the same place
 * the guide's command comes from, so the two never show different things.
 *
 * `accessKey` is the key minted with the gateway, known only on the page
 * the person lands on right after sharing; afterwards the snippets carry a
 * placeholder and say where a new key comes from.
 */
export function ConnectSnippets({
  gateway,
  orgSlug,
  accessKey,
}: {
  gateway: ConnectableGateway
  orgSlug: string
  accessKey?: string | null
}) {
  const snippets = sharedToolsSnippets(gateway, orgSlug, accessKey)
  const address = mcpEndpointFor(gateway, orgSlug)
  return (
    <Card data-testid="connect-snippets">
      <CardHeader>
        <CardTitle>Connect a client</CardTitle>
        <CardDescription>One address works in every client: MCP, UTCP and Skills.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CopyField value={address} label="Address" />
        <Tabs defaultValue={snippets[0].id} className="space-y-3">
          <TabsList className="h-auto flex-wrap justify-start">
            {snippets.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {snippets.map((s) => (
            <TabsContent key={s.id} value={s.id} className="space-y-2" data-testid={`snippet-${s.id}`}>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
              <CodeBlock value={s.value} language={s.language} maxHeight="220px" />
            </TabsContent>
          ))}
        </Tabs>
        {!accessKey && (
          <p className="text-xs text-muted-foreground" data-testid="key-placeholder-note">
            Replace {ACCESS_KEY_PLACEHOLDER} with an access key. Make one under Advanced, with Generate key.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
