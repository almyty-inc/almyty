import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlmytyClient } from '../client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('AlmytyClient response parsing', () => {
  let client: AlmytyClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AlmytyClient('https://api.example.com', 'test-token');
  });

  describe('listGateways', () => {
    it('parses { data: { gateways: [...] } } shape', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          gateways: [
            { id: 'gw-1', name: 'My Gateway', type: 'skills' },
          ],
        },
      }));

      const gateways = await client.listGateways();
      expect(gateways).toHaveLength(1);
      expect(gateways[0]).toEqual({ id: 'gw-1', name: 'My Gateway', type: 'skills' });
    });

    it('handles empty gateway list', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { gateways: [] },
      }));

      const gateways = await client.listGateways();
      expect(gateways).toHaveLength(0);
    });

    it('does not crash on unexpected shape', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        success: true,
        data: 'unexpected-string',
      }));

      const gateways = await client.listGateways();
      expect(gateways).toHaveLength(0);
    });
  });

  describe('fetchSkills', () => {
    it('resolves @org/gateway ref then fetches skills', async () => {
      // First call: resolveGateway
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { id: 'gw-uuid', name: 'test', type: 'skills' },
      }));
      // Second call: fetchSkills
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { skills: [{ name: 'my-skill', fileName: 'almyty-my-skill', content: '# skill' }] },
      }));

      const skills = await client.fetchSkills('@org/gateway');
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-skill');
    });
  });

  describe('request URL construction', () => {
    it('does not include /api prefix', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { gateways: [] },
      }));

      await client.listGateways();

      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('https://api.example.com/gateways');
      expect(url).not.toContain('/api/');
    });
  });

  // The skill-name → tool UUID resolver has to mirror the server's
  // skill-generator slugging *exactly* — including the head-segment
  // truncation it applies when `${gateway}-${suffix}` exceeds 64
  // chars. Without this branch, every Google-Translate-style gRPC
  // gateway with long shared prefixes was unrunnable from the CLI:
  // the SKILL.md in the agent dir held the truncated name but the
  // resolver only knew how to match the full composed form.
  describe('executeSkill name resolution', () => {
    it('matches a tool by its truncated kebab name (server-side head-drop)', async () => {
      const gatewaySlug = 'translate-grpc';
      // Long tool name that triggers truncation.
      const longTool = {
        id: 'tool-uuid-1',
        name: 'real_google_translate_protobuf_translation_service_detect_13aff1',
      };

      // 1) GET /gateways/:id → endpoint slug
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { id: 'gw-1', endpoint: `/${gatewaySlug}` },
      }));
      // 2) GET /gateways/:id/tools → page 1
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: {
          gatewayTools: [{ tool: longTool }],
          totalPages: 1,
        },
      }));
      // 3) POST /gateways/:id/skills/:toolId/execute
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { success: true, data: 42 },
      }));

      const truncatedSkillName =
        'translate-grpc-protobuf-translation-service-detect-13aff1';
      const result = await client.executeSkill('gw-1', truncatedSkillName, {});
      expect(result?.data?.success).toBe(true);

      // Final POST must use the resolved UUID, not the slug.
      const lastCall = mockFetch.mock.calls.at(-1)!;
      expect(lastCall[0]).toContain(`/skills/${longTool.id}/execute`);
    });

    it('falls back to raw slug when no truncation is needed', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { id: 'gw-2', endpoint: '/short-gw' },
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: {
          gatewayTools: [
            { tool: { id: 'tool-uuid-2', name: 'simple_op' } },
          ],
          totalPages: 1,
        },
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

      await client.executeSkill('gw-2', 'short-gw-simple-op', {});
      const lastCall = mockFetch.mock.calls.at(-1)!;
      expect(lastCall[0]).toContain('/skills/tool-uuid-2/execute');
    });

    it('throws a clear error when no tool matches', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { id: 'gw-3', endpoint: '/other' },
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: { gatewayTools: [], totalPages: 1 },
      }));
      await expect(
        client.executeSkill('gw-3', 'something-not-installed', {}),
      ).rejects.toThrow(/not found in gateway/);
    });
  });
});
