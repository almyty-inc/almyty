import { HttpException } from '@nestjs/common';

import { GatewayType } from '../../../entities/gateway.entity';
import { GlobalExceptionFilter } from '../../../common/filters/global-exception.filter';
import { assertOAuthScope, missingOAuthScope } from '../services/mcp-oauth-scope';

describe('an MCP OAuth token reaches only what its scope grants', () => {
  const oauth = (...scopes: string[]) => ({ scopes, metadata: { authMethod: 'oauth2' } });
  const rpc = (method: string) => ({ jsonrpc: '2.0', id: 1, method });

  it('maps each MCP namespace to its scope', () => {
    expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:resources'), rpc('tools/call'))).toBe('mcp:tools');
    expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:tools'), rpc('resources/read'))).toBe('mcp:resources');
    expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:tools'), rpc('prompts/get'))).toBe('mcp:prompts');
    expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:tools'), rpc('tools/list'))).toBeNull();
  });

  it('lets the session methods through on any grant, and mcp:* through everywhere', () => {
    for (const method of ['initialize', 'ping', 'notifications/initialized', 'logging/setLevel']) {
      expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:resources'), rpc(method))).toBeNull();
    }
    expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:*'), rpc('tools/call'))).toBeNull();
  });

  it('checks every message of a batch', () => {
    const batch = [rpc('resources/list'), rpc('tools/call')];
    expect(missingOAuthScope(GatewayType.MCP, oauth('mcp:resources'), batch)).toBe('mcp:tools');
  });

  it('holds the tool protocols that are not MCP to mcp:tools', () => {
    expect(missingOAuthScope(GatewayType.UTCP, oauth('mcp:resources'), {})).toBe('mcp:tools');
    expect(missingOAuthScope(GatewayType.TOOLS, oauth('mcp:prompts'), {})).toBe('mcp:tools');
    expect(missingOAuthScope(GatewayType.UTCP, oauth('mcp:tools'), {})).toBeNull();
  });

  it('leaves credentials that are not MCP OAuth tokens to their own rules', () => {
    expect(missingOAuthScope(GatewayType.MCP, { scopes: [], metadata: { authMethod: 'api_key' } }, rpc('tools/call'))).toBeNull();
    expect(missingOAuthScope(GatewayType.MCP, null, rpc('tools/call'))).toBeNull();
  });

  it('refuses with 403 insufficient_scope and a challenge naming the scope', () => {
    let thrown: any;
    try {
      assertOAuthScope(GatewayType.MCP, oauth('mcp:resources'), rpc('tools/call'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown.getStatus()).toBe(403);
    expect(thrown.wwwAuthenticate).toBe('Bearer error="insufficient_scope", scope="mcp:tools"');

    // And the app's exception filter puts the challenge on the response.
    const response: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host: any = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/o/gw', method: 'POST', headers: {} }) }),
    };
    new GlobalExceptionFilter().catch(thrown, host);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="mcp:tools"');
  });
});
