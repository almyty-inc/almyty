import 'reflect-metadata';

import { McpContentHandler } from '../services/mcp-content.handler';

/**
 * A resource or prompt that does not exist (or is outside the caller's
 * set) is -32602 Invalid params with the uri or name in `data`, for every
 * protocol version (MCP 2026-07-28 / SEP-2164; design doc). It used to be
 * a custom -32001.
 */
describe('MCP not-found errors', () => {
  const handler = new McpContentHandler(
    {} as any,
    { findOne: jest.fn().mockResolvedValue(null) } as any,
    {} as any,
    {} as any,
    { getToolsForScope: jest.fn().mockResolvedValue([]), sanitizeToolName: (n: string) => n } as any,
    {} as any,
    {} as any,
  );

  it.each([
    'file:///etc/passwd',
    'almyty://resources/not-a-uuid',
    'almyty://resources/6b1f0c1e-8a7d-4f2b-9c3e-0d4a5b6c7d8e',
  ])('resources/read of %s', async (uri) => {
    await expect(handler.handleResourceRead({ uri }, 'org-1', { id: 'u-1' })).rejects.toEqual(
      expect.objectContaining({ code: -32602, message: 'Resource not found', data: { uri } }),
    );
  });

  it.each([
    ['an unknown prompt', 'summarize', "Prompt 'summarize' not found"],
    ['a prompt for a tool out of scope', 'use-get_pet', "Tool 'get_pet' not found"],
  ])('prompts/get of %s', async (_label, name, message) => {
    await expect(handler.handlePromptGet({ name }, 'org-1', 'gw-1')).rejects.toEqual(
      expect.objectContaining({ code: -32602, message, data: { name } }),
    );
  });
});
