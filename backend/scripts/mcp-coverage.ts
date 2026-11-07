/**
 * Writes the generated section of docs/design/almyty-mcp-coverage.md:
 * every controller route and what the management MCP does with it.
 *
 *   npm run mcp:coverage
 *
 * management-coverage.guard.spec.ts fails when the document is stale.
 */
import * as fs from 'fs';
import * as path from 'path';

import { allControllerRoutes } from '../src/test/controller-routes';
import { coverageMarkdown, withGeneratedSection } from '../src/test/mcp-coverage-report';

const DOC = path.join(__dirname, '..', '..', 'docs', 'design', 'almyty-mcp-coverage.md');

const current = fs.readFileSync(DOC, 'utf8');
const next = withGeneratedSection(current, coverageMarkdown(allControllerRoutes()));
if (next === current) {
  console.log('docs/design/almyty-mcp-coverage.md is up to date');
} else {
  fs.writeFileSync(DOC, next);
  console.log('wrote docs/design/almyty-mcp-coverage.md');
}
