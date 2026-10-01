import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A gateway serves exactly one protocol: MCP, UTCP or Skills. The `acp` and
 * `openai_chat` gateway types are gone (an agent's OpenAI-compatible API is
 * the agent's own endpoint, and ACP is the @almyty/acp-server package over
 * the agents API), so gateways of those types are deleted, with their tool
 * attachments and access keys; every other row that points at a gateway
 * cascades or is nulled by its foreign key.
 */
export class DropAcpAndOpenAiChatGateways1750813762000 implements MigrationInterface {
  name = 'DropAcpAndOpenAiChatGateways1750813762000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const gone = `SELECT "id" FROM "gateways" WHERE "type" IN ('acp', 'openai_chat')`;
    await queryRunner.query(`DELETE FROM "gateway_tools" WHERE "gatewayId" IN (${gone})`);
    await queryRunner.query(`DELETE FROM "api_keys" WHERE "gatewayId" IN (${gone})`);
    await queryRunner.query(`DELETE FROM "gateways" WHERE "type" IN ('acp', 'openai_chat')`);
  }

  public async down(): Promise<void> {
    // Deleted rows are not restored.
  }
}
