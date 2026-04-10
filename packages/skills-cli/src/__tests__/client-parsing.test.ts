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
});
