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

export interface ParsedRef {
  type: 'gateway' | 'skill' | 'search' | 'uuid';
  orgSlug?: string;
  gatewaySlug?: string;
  skillName?: string;
  uuid?: string;
  raw: string;
}

export function parseRef(ref: string): ParsedRef {
  if (!ref) return { type: 'search', raw: ref };

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(ref)) return { type: 'uuid', uuid: ref, raw: ref };

  // Accept both @org/gateway and org/gateway (@ is optional)
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref;
  const parts = normalized.split('/');
  if (parts.length === 3) {
    return { type: 'skill', orgSlug: parts[0], gatewaySlug: parts[1], skillName: parts[2], raw: ref };
  }
  if (parts.length === 2) {
    return { type: 'gateway', orgSlug: parts[0], gatewaySlug: parts[1], raw: ref };
  }

  return { type: 'search', raw: ref };
}

export class AlmytyClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request(path: string): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication failed. Run: npx @almyty/auth login');
      }
      const text = await response.text();
      throw new Error(`API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  private async post(path: string, body: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async resolveGateway(orgSlug: string, gatewaySlug: string): Promise<GatewayInfo> {
    const data: any = await this.request(`/gateways/resolve/${orgSlug}/${gatewaySlug}`);
    const gw = data?.data || data;
    return {
      id: gw.id,
      name: gw.name,
      type: gw.type,
    };
  }

  async fetchSkills(gatewayIdOrRef: string): Promise<SkillFile[]> {
    const gatewayId = await this.resolveRef(gatewayIdOrRef);
    const data: any = await this.request(`/gateways/${gatewayId}/skills/individual`);
    return data?.data?.skills || [];
  }

  async fetchGateway(gatewayIdOrRef: string): Promise<GatewayInfo> {
    if (gatewayIdOrRef.includes('/')) {
      const parsed = parseRef(gatewayIdOrRef);
      if (parsed.orgSlug && parsed.gatewaySlug) {
        return this.resolveGateway(parsed.orgSlug, parsed.gatewaySlug);
      }
    }
    const data: any = await this.request(`/gateways/${gatewayIdOrRef}`);
    const gw = data?.data || data;
    return {
      id: gw.id,
      name: gw.name,
      type: gw.type,
    };
  }

  async listGateways(): Promise<GatewayInfo[]> {
    const data: any = await this.request('/gateways');
    const gateways = data?.data?.gateways || data?.data?.data || data?.data || [];
    return (Array.isArray(gateways) ? gateways : []).map((gw: any) => ({
      id: gw.id,
      name: gw.name,
      type: gw.type,
    }));
  }

  async searchSkills(query: string): Promise<any[]> {
    const resp: any = await this.request(`/gateways/skills/search?q=${encodeURIComponent(query)}`);
    return resp?.data || [];
  }

  async fetchAllSkills(): Promise<SkillFile[]> {
    const resp: any = await this.request('/gateways/all-skills');
    const gateways = resp?.data || [];
    const skills: SkillFile[] = [];
    for (const gw of gateways) {
      for (const skill of gw.skills || []) {
        (skill as any).gateway = gw.gatewayName;
        (skill as any).gatewayId = gw.gatewayId;
        (skill as any).orgSlug = gw.orgSlug;
        (skill as any).gatewaySlug = gw.gatewaySlug;
        skills.push(skill);
      }
    }
    return skills;
  }

  async executeSkill(gatewayId: string, toolId: string, parameters: Record<string, any>): Promise<any> {
    // The execute endpoint expects a UUID. If toolId is a name slug,
    // resolve it by listing the gateway's tools and matching.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let resolvedId = toolId;
    if (!uuidRegex.test(toolId)) {
      const tools: any = await this.request(`/gateways/${gatewayId}/tools`);
      const list = tools?.data?.gatewayTools || tools?.data?.data || tools?.data || [];
      const match = (Array.isArray(list) ? list : []).find((gt: any) => {
        const t = gt.tool || gt;
        const slug = t.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return slug === toolId || t.name === toolId;
      });
      if (!match) {
        throw new Error(`Tool "${toolId}" not found in gateway ${gatewayId}`);
      }
      resolvedId = (match.tool || match).id;
    }
    return this.post(`/gateways/${gatewayId}/skills/${resolvedId}/execute`, { parameters });
  }

  private async resolveRef(ref: string): Promise<string> {
    if (ref.includes('/')) {
      const parsed = parseRef(ref);
      if (parsed.orgSlug && parsed.gatewaySlug) {
        const gw = await this.resolveGateway(parsed.orgSlug, parsed.gatewaySlug);
        return gw.id;
      }
    }
    return ref;
  }
}
