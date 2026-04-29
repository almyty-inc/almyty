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
    // resolve by listing the gateway's tools and matching either
    // the raw tool name, its kebab slug, OR the new
    // `${gateway-slug}-${tool-slug}` composed form (with shared
    // head segments deduped — the same rule the backend uses to
    // generate SKILL.md names).
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let resolvedId = toolId;
    if (!uuidRegex.test(toolId)) {
      const gateway = await this.request(`/gateways/${gatewayId}`).catch(() => null);
      const gatewaySlug =
        (gateway as any)?.data?.endpoint?.replace(/^\/+/, '') || '';

      // Walk every page — server caps limit at 100.
      const allTools: any[] = [];
      let page = 1;
      while (true) {
        const resp: any = await this.request(
          `/gateways/${gatewayId}/tools?limit=100&page=${page}`,
        );
        const data = resp?.data || resp;
        const items =
          data?.gatewayTools || data?.data || (Array.isArray(data) ? data : []);
        allTools.push(...(Array.isArray(items) ? items : []));
        const totalPages = data?.totalPages ?? 1;
        if (page >= totalPages || items.length === 0) break;
        page++;
        if (page > 50) break;
      }

      const slugify = (s: string) =>
        (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const dedupeShared = (head: string, tail: string) => {
        const h = head.split('-').filter(Boolean);
        const t = tail.split('-').filter(Boolean);
        let i = 0;
        while (i < t.length && i < h.length && t[i] === h[i]) i++;
        return t.slice(i).join('-');
      };
      // Mirror the server's skill-generator truncation when
      // `${gateway}-${suffix}` exceeds 64 chars: drop kebab
      // segments off the *head* of the suffix until the whole
      // thing fits, falling back to a tail substring if a single
      // segment is itself longer than the remaining budget. Cutting
      // from the head keeps the unique tail of long method names
      // (e.g. ~40 google-translate gRPC methods that all share a
      // long prefix) addressable from the CLI.
      const composeAndTruncate = (gw: string, suffix: string): string => {
        if (!gw) return suffix;
        const combined = `${gw}-${suffix}`;
        if (combined.length <= 64) return combined;
        const room = 64 - gw.length - 1;
        if (room <= 0) return gw.slice(0, 64);
        const segments = suffix.split('-').filter(Boolean);
        let trimmed = segments.join('-');
        while (trimmed.length > room && segments.length > 1) {
          segments.shift();
          trimmed = segments.join('-');
        }
        if (trimmed.length > room) trimmed = trimmed.slice(-room);
        return `${gw}-${trimmed.replace(/^-+|-+$/g, '')}`;
      };

      const match = allTools.find((gt: any) => {
        const t = gt.tool || gt;
        if (!t) return false;
        const rawName = t.name || '';
        const slug = slugify(rawName);
        const dedupedSuffix = dedupeShared(gatewaySlug, slug);
        const composed = gatewaySlug
          ? `${gatewaySlug}-${dedupedSuffix}`
          : slug;
        const truncated = composeAndTruncate(gatewaySlug, dedupedSuffix);
        return (
          rawName === toolId ||
          slug === toolId ||
          composed === toolId ||
          truncated === toolId
        );
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
