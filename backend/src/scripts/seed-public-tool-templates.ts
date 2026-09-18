/**
 * Apply the public tool-hub catalogue.
 *
 * Public templates are the rows with `organizationId IS NULL` -- the ones
 * every tenant sees. Nothing reachable over HTTP writes them: publishing
 * always stamps the caller's organization, because a tenant that could
 * write the public catalogue could put a tool of its choosing in front of
 * every other tenant. This script is the operator path, and it is the
 * only one.
 *
 * Idempotent. Matches on name, refreshes the definition, never resets
 * installCount, never deletes a row it does not know about.
 *
 *   cd backend && npm run seed:tool-templates
 */
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppModule } from '../app.module';
import { ToolTemplate } from '../entities/tool-template.entity';
import {
  PUBLIC_TOOL_TEMPLATES,
  seedPublicToolTemplates,
} from '../modules/tool-hub/public-templates.seed';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const repository = app.get<Repository<ToolTemplate>>(getRepositoryToken(ToolTemplate));
    const { created, updated } = await seedPublicToolTemplates(repository);
    // eslint-disable-next-line no-console
    console.log(
      `tool hub: ${created} public template(s) created, ${updated} refreshed ` +
        `(${PUBLIC_TOOL_TEMPLATES.length} in the catalogue)`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('tool hub seed failed:', error);
  process.exit(1);
});
