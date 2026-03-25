import type { SkillFile } from './client.js';

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

- User wants to discover available API tools
- User wants to find a specific API capability
- User wants to run an API tool directly
- User needs to list what skills are installed

## Commands

### List all available skills
\`\`\`bash
npx @almyty/skills list
\`\`\`

### Search for skills
\`\`\`bash
npx @almyty/skills search <query>
\`\`\`

### Install a specific skill
\`\`\`bash
npx @almyty/skills install @<org>/<gateway>/<skill-name>
\`\`\`

### Run a skill directly
\`\`\`bash
npx @almyty/skills run @<org>/<gateway>/<skill-name> --param1 value1 --param2 value2
\`\`\`

### Start the skill daemon (auto-syncs all skills)
\`\`\`bash
npx @almyty/skills daemon
\`\`\`
`;

  return {
    name: 'skills',
    fileName: 'almyty-skills',
    content,
  };
}
