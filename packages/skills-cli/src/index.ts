#!/usr/bin/env node

/**
 * @apifai/skills — Install API skills into AI coding agents.
 *
 * Usage:
 *   npx @apifai/skills login                          # Authenticate
 *   npx @apifai/skills install --gateway <id>          # Install skills
 *   npx @apifai/skills list --gateway <id>             # List available skills
 *   npx @apifai/skills installed                       # Show installed skills
 *   npx @apifai/skills remove                          # Remove installed skills
 *   npx @apifai/skills logout                          # Remove credentials
 */

import { login, logout, resolveAuth } from './auth.js';
import { ApifaiClient } from './client.js';
import { detectAgents, getDefaultTargets } from './agents.js';
import { installSkills, removeSkills, listInstalledSkills } from './installer.js';

const VERSION = '1.0.0';

function printHelp(): void {
  console.log(`
@apifai/skills v${VERSION} — Install API skills into AI coding agents

USAGE
  npx @apifai/skills <command> [options]

COMMANDS
  login                         Authenticate with apifai
  logout                        Remove stored credentials
  install  --gateway <id>       Fetch skills and install into agent directories
  list     --gateway <id>       List available skills for a gateway
  gateways                      List all your gateways
  installed                     Show locally installed apifai skills
  remove                        Remove all installed apifai skills

OPTIONS
  --gateway, -g <id>            Gateway ID
  --url <url>                   apifai API URL (default: https://api.apif.ai)
  --dir <path>                  Project directory (default: current directory)
  --help, -h                    Show help
  --version, -v                 Show version

ENVIRONMENT
  APIFAI_TOKEN                  Auth token (alternative to login)
  APIFAI_URL                    API URL (default: https://api.apif.ai)

EXAMPLES
  npx @apifai/skills login
  npx @apifai/skills install --gateway abc-123-def
  npx @apifai/skills list --gateway abc-123-def
  npx @apifai/skills remove
`);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--gateway' || arg === '-g') {
      parsed.gateway = args[++i] || '';
    } else if (arg === '--url') {
      parsed.url = args[++i] || '';
    } else if (arg === '--dir') {
      parsed.dir = args[++i] || '';
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--version' || arg === '-v') {
      parsed.version = true;
    } else if (!arg.startsWith('-')) {
      parsed.command = arg;
    }
    i++;
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    return;
  }

  if (args.help || !args.command) {
    printHelp();
    return;
  }

  const command = args.command as string;
  const projectDir = (args.dir as string) || process.cwd();
  const urlOverride = args.url as string | undefined;

  switch (command) {
    case 'login': {
      const url = urlOverride || process.env.APIFAI_URL || 'https://api.apif.ai';
      await login(url);
      break;
    }

    case 'logout': {
      logout();
      break;
    }

    case 'gateways': {
      const { url, token } = resolveAuth();
      const client = new ApifaiClient(urlOverride || url, token);
      const gateways = await client.listGateways();

      if (gateways.length === 0) {
        console.log('No gateways found. Create one at https://app.apif.ai/gateways');
        return;
      }

      console.log('\nYour gateways:\n');
      for (const gw of gateways) {
        console.log(`  ${gw.name}`);
        console.log(`    ID:   ${gw.id}`);
        console.log(`    Type: ${gw.type}`);
        console.log('');
      }
      console.log(`Use: npx @apifai/skills install --gateway <id>`);
      break;
    }

    case 'list': {
      const gatewayId = args.gateway as string;
      if (!gatewayId) {
        console.error('Error: --gateway <id> is required');
        console.error('  npx @apifai/skills list --gateway <id>');
        console.error('  npx @apifai/skills gateways    # list your gateways');
        process.exit(1);
      }

      const { url, token } = resolveAuth();
      const client = new ApifaiClient(urlOverride || url, token);
      const skills = await client.fetchSkills(gatewayId);

      if (skills.length === 0) {
        console.log('No skills available. Assign tools to your gateway first.');
        return;
      }

      console.log(`\n${skills.length} skills available:\n`);
      for (const skill of skills) {
        console.log(`  • ${skill.name}`);
      }
      console.log(`\nInstall: npx @apifai/skills install --gateway ${gatewayId}`);
      break;
    }

    case 'install': {
      const gatewayId = args.gateway as string;
      if (!gatewayId) {
        console.error('Error: --gateway <id> is required');
        console.error('  npx @apifai/skills install --gateway <id>');
        console.error('  npx @apifai/skills gateways    # list your gateways');
        process.exit(1);
      }

      const { url, token } = resolveAuth();
      const client = new ApifaiClient(urlOverride || url, token);

      // Fetch gateway info and skills
      console.log('Fetching skills...');
      const [gateway, skills] = await Promise.all([
        client.fetchGateway(gatewayId).catch(() => null),
        client.fetchSkills(gatewayId),
      ]);

      if (skills.length === 0) {
        console.log('No skills found. Assign tools to your gateway first.');
        return;
      }

      const gwName = gateway?.name || gatewayId;
      console.log(`\nGateway: ${gwName} (${skills.length} skills)`);

      // Detect agents
      let targets = detectAgents(projectDir);
      if (targets.length === 0) {
        console.log('No agent directories detected. Installing to defaults...');
        targets = getDefaultTargets(projectDir);
      }

      // Install to each detected agent
      const results = targets.map(target => installSkills(skills, target));

      console.log('');
      for (const result of results) {
        console.log(`✓ ${result.agent}: ${result.installed} skills → ${result.skillsDir}`);
      }

      const totalInstalled = results.reduce((sum, r) => sum + r.installed, 0);
      console.log(`\nInstalled ${totalInstalled} skill files across ${results.length} agent(s).`);
      console.log('Skills will be automatically loaded by your AI coding agent.');
      break;
    }

    case 'installed': {
      let targets = detectAgents(projectDir);
      if (targets.length === 0) {
        targets = getDefaultTargets(projectDir);
      }

      let totalFound = 0;
      for (const target of targets) {
        const installed = listInstalledSkills(target);
        if (installed.length > 0) {
          console.log(`\n${target.name} (${target.skillsDir}):`);
          for (const name of installed) {
            console.log(`  • ${name}`);
          }
          totalFound += installed.length;
        }
      }

      if (totalFound === 0) {
        console.log('No apifai skills installed in this directory.');
        console.log('Install: npx @apifai/skills install --gateway <id>');
      }
      break;
    }

    case 'remove': {
      let targets = detectAgents(projectDir);
      if (targets.length === 0) {
        targets = getDefaultTargets(projectDir);
      }

      let totalRemoved = 0;
      for (const target of targets) {
        const removed = removeSkills(target);
        if (removed > 0) {
          console.log(`✓ Removed ${removed} skills from ${target.skillsDir}`);
          totalRemoved += removed;
        }
      }

      if (totalRemoved === 0) {
        console.log('No apifai skills found to remove.');
      } else {
        console.log(`\nRemoved ${totalRemoved} skill(s) total.`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
