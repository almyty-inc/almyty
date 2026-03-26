/**
 * HTTP proxy to the almyty backend.
 * Fetches tools and executes tool calls via the MCP JSON-RPC API.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class AlmytyProxy {
  private baseUrl: string;
  private token: string;
  private gatewayId?: string;

  constructor(baseUrl: string, token: string, gatewayId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.gatewayId = gatewayId;
  }

  /**
   * Fetch available tools from the almyty backend.
   */
  async fetchTools(): Promise<McpToolDefinition[]> {
    const endpoint = this.gatewayId
      ? `${this.baseUrl}/api/gateways/${this.gatewayId}/mcp`
      : `${this.baseUrl}/api/mcp`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch tools (${response.status}): ${text}`);
    }

    const data: any = await response.json();

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }

    return data.result?.tools || [];
  }

  /**
   * Fetch skills from the almyty backend and return as resource content.
   */
  async fetchSkills(): Promise<Array<{ name: string; content: string; toolCount: number }>> {
    const endpoint = this.gatewayId
      ? `${this.baseUrl}/api/gateways/${this.gatewayId}/mcp`
      : `${this.baseUrl}/api/mcp`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'skills/list',
        params: { limit: 100 },
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data: any = await response.json();
    return data.result?.skills || [];
  }

  /**
   * Execute a tool call via the almyty backend.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const endpoint = this.gatewayId
      ? `${this.baseUrl}/api/gateways/${this.gatewayId}/mcp`
      : `${this.baseUrl}/api/mcp`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tool execution failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();

    if (data.error) {
      throw new Error(`Tool error: ${data.error.message}`);
    }

    // Extract text content from MCP response
    const content = data.result?.content;
    if (Array.isArray(content) && content.length > 0) {
      const textContent = content.find((c: any) => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
    }

    return data.result;
  }
}
