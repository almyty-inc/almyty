/**
 * HTTP client to the apifai backend.
 * Fetches individual skills and gateway info for installation.
 */

export interface SkillFile {
  name: string;
  fileName: string;
  content: string;
}

export interface GatewayInfo {
  id: string;
  name: string;
  type: string;
}

export class ApifaiClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request(path: string): Promise<any> {
    const url = `${this.baseUrl}/api${path}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication failed. Run: npx @apifai/skills login');
      }
      const text = await response.text();
      throw new Error(`API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  /**
   * Fetch individual SKILL.md files for a gateway.
   */
  async fetchSkills(gatewayId: string): Promise<SkillFile[]> {
    const data: any = await this.request(`/gateways/${gatewayId}/skills/individual`);
    return data?.data?.skills || [];
  }

  /**
   * Fetch gateway info.
   */
  async fetchGateway(gatewayId: string): Promise<GatewayInfo> {
    const data: any = await this.request(`/gateways/${gatewayId}`);
    const gw = data?.data || data;
    return {
      id: gw.id,
      name: gw.name,
      type: gw.type,
    };
  }

  /**
   * List all gateways for the authenticated user.
   */
  async listGateways(): Promise<GatewayInfo[]> {
    const data: any = await this.request('/gateways');
    const gateways = data?.data?.data?.gateways || data?.data?.data || data?.data || [];
    return gateways.map((gw: any) => ({
      id: gw.id,
      name: gw.name,
      type: gw.type,
    }));
  }
}
