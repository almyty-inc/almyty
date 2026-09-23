import type { SkillFile } from './client.js';

/**
 * The one skill the daemon always installs: how to reach the rest.
 *
 * It is read by a coding agent, so every command in it has to exist.
 * It documented `install`, `list`, `search`, `run` and `daemon` only,
 * and wrote refs with a mandatory leading `@` the CLI treats as
 * optional — so an agent copying it out learned a surface that was
 * both smaller and subtly wrong.
 */
export function generateMetaSkill(): SkillFile {
  const content = `---
name: almyty-skills
description: Discover, search, install, and run API skills from almyty. Use when the user wants to find or use API tools.
metadata:
  author: almyty
  type: meta
---

# almyty Skills Manager

Manage API skills powered by almyty — a universal API-to-AI tool gateway.

## When to use

- The user wants to discover available API tools
- The user wants to find a specific API capability
- The user wants to run an API tool directly
- The user needs to know which skills are installed here

## References

A skill is addressed as \`org/gateway/skill\`, a whole gateway as
\`org/gateway\`. A leading \`@\` is optional. A bare name is treated as a
search and installs only when it matches exactly one skill.

## Commands

Add \`--json\` to any read command for parseable output.

### What gateways exist
\`\`\`bash
npx @almyty/skills gateways
\`\`\`

### List available skills
\`\`\`bash
npx @almyty/skills list
npx @almyty/skills list acme/billing
\`\`\`

### Search for skills
\`\`\`bash
npx @almyty/skills search <query>
\`\`\`

### Install skills (writes SKILL.md into this project's agent dirs)
\`\`\`bash
npx @almyty/skills install acme/billing --dry-run   # show the exact files first
npx @almyty/skills install acme/billing/get-invoice
\`\`\`

### Run a skill directly
\`\`\`bash
npx @almyty/skills run acme/billing/get-invoice --invoiceId inv_123
\`\`\`

### What is installed here, and undo it
\`\`\`bash
npx @almyty/skills installed
npx @almyty/skills remove
\`\`\`

### Keep skills in sync on a timer
\`\`\`bash
npx @almyty/skills daemon              # every gateway
npx @almyty/skills watch acme/billing # one gateway
\`\`\`

## Exit codes

\`2\` usage error, \`3\` not authenticated (run \`npx @almyty/auth login\`),
\`4\` no such gateway or skill, \`5\` the skill ran and failed.
`;

  return {
    name: 'skills',
    fileName: 'almyty-skills',
    content,
  };
}
