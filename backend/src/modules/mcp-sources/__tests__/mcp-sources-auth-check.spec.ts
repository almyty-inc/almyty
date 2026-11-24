import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { McpSourcesController } from '../mcp-sources.controller';
import { McpOAuthClientService } from '../../connections/mcp-oauth/mcp-oauth-client.service';
import { fakeEnvelope, fakeRepo, fixtureHttp } from '../../connections/__tests__/test-support';
import { SERVER, world } from '../../connections/__tests__/mcp-oauth-world';

/**
 * POST /organizations/:id/mcp-sources/auth-check: the Add MCP server page
 * asks it whether the server wants a sign-in before anything is saved.
 */
describe('McpSourcesController auth-check', () => {
  it('is a POST under the sources, declared before the :id routes', () => {
    const proto = McpSourcesController.prototype as any;
    expect(Reflect.getMetadata(PATH_METADATA, proto.checkAuth)).toBe('auth-check');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.checkAuth)).toBe(RequestMethod.POST);
    const order = Object.getOwnPropertyNames(proto);
    expect(order.indexOf('checkAuth')).toBeLessThan(order.indexOf('findOne'));
  });

  it('answers sign_in for an OAuth-protected server and saves nothing', async () => {
    const sources = { create: jest.fn() };
    const http = fixtureHttp(world().routes);
    const oauth = new McpOAuthClientService(fakeRepo<any>() as any, fakeEnvelope, http.http);
    const controller = new McpSourcesController(sources as any, oauth);
    await expect(controller.checkAuth('org-1', { url: ` ${SERVER} ` })).resolves.toEqual({ success: true, data: { auth: 'sign_in' } });
    expect(http.calls[0]).toMatchObject({ url: SERVER, init: { method: 'POST' } });
    expect(sources.create).not.toHaveBeenCalled();
  });

  it('answers unknown when signing in to MCP servers is not available', async () => {
    const controller = new McpSourcesController({} as any);
    await expect(controller.checkAuth('org-1', { url: SERVER })).resolves.toEqual({ success: true, data: { auth: 'unknown' } });
  });
});
