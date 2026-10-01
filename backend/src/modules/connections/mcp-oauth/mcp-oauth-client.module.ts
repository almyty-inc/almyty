import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Credential } from '../../../entities/credential.entity';
import { McpOAuthClientService } from './mcp-oauth-client.service';

/**
 * Signing in to remote MCP servers (the client side of MCP authorization).
 * Its own module so both the Connections layer (the sign-in) and MCP
 * sources (using and refreshing the token) depend on it without depending
 * on each other.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Credential])],
  providers: [McpOAuthClientService],
  exports: [McpOAuthClientService],
})
export class McpOAuthClientModule {}
