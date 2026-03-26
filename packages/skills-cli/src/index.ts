#!/usr/bin/env node

import { login, logout, resolveAuth } from './auth.js';
import { AlmytyClient, parseRef } from './client.js';
import { detectAgents, getDefaultTargets, getAllTargets } from './agents.js';
import { installSkills, removeSkills, listInstalledSkills } from './installer.js';
import { loadConfig, resolveTargets } from './config.js';
import { generateMetaSkill } from './meta-skill.js';

const VERSION = '1.0.0';

function printHelp(): void {
  console.log(`
almyty Skills CLI v${VERSION}

Usage:
  npx @almyty/skills <command> [options]

Commands:
  login                          Authenticate with almyty
  logout                         Remove stored credentials
  daemon                         Start skill daemon (syncs all skills)
  install <ref>                  Install skills
  list [ref]                     List available skills
  search <query>                 Search for skills
  run <ref> [--key value ...]    Execute a skill
  installed                      Show locally installed skills
  remove                         Remove all installed skills
  gateways                       List your gateways

References:
  @org/gateway                   All skills from a gateway
  @org/gateway/skill             A specific skill
  skill-name                     Search by name
  <uuid>                         Direct ID reference

Config:
  .almytyrc                      JSON config file (project or home dir)
  ALMYTY_SKILLS_DIR              Override skill installation directory
  ALMYTY_URL                     Override API URL
  ALMYTY_TOKEN                   Override auth token

Options:
  --interval, -i <seconds>       Daemon poll interval in seconds (default: 60)
  --url <url>                    almyty API URL (default: https://api.almyty.com)
  --dir <path>                   Project directory (default: current directory)
  --help, -h                     Show help
  --version, -v                  Show version

Examples:
  npx @almyty/skills daemon
  npx @almyty/skills install @myorg/petstore/get-pet
  npx @almyty/skills search "weather"
  npx @almyty/skills run @myorg/petstore/get-pet --petId 123
`);
}

interface ParsedArgs {
  command?: string;
  ref?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--gateway' || arg === '-g') {
      result.flags.gateway = argv[++i] || '';
    } else if (arg === '--url') {
      result.flags.url = argv[++i] || '';
    } else if (arg === '--dir') {
      result.flags.dir = argv[++i] || '';
    } else if (arg === '--interval' || arg === '-i') {
      result.flags.interval = argv[++i] || '60';
    } else if (arg === '--help' || arg === '-h') {
      result.flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.flags.version = true;
    } else if (arg.startsWith('@')) {
      result.ref = arg;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.flags[key] = next;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

function getRef(args: ParsedArgs): string | null {
  if (args.ref) return args.ref;
  if (args.flags.gateway) return args.flags.gateway as string;
  if (args.positional.length > 0) return args.positional[0];
  return null;
}

function requireRef(args: ParsedArgs, command: string): string {
  const ref = getRef(args);
  if (!ref) {
    console.error('Error: reference required');
    console.error(`  npx @almyty/skills ${command} @<org>/<gateway>`);
    console.error(`  npx @almyty/skills ${command} <skill-name>`);
    process.exit(1);
  }
  return ref;
}

function parseRunParams(args: ParsedArgs): Record<string, any> {
  const params: Record<string, any> = {};
  const entries = Object.entries(args.flags);
  for (const [key, value] of entries) {
    if (['url', 'dir', 'help', 'version', 'interval', 'gateway'].includes(key)) continue;
    params[key] = value;
  }
  return params;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }

  if (args.flags.help || !args.command) {
    printHelp();
    return;
  }

  const command = args.command;
  const projectDir = (args.flags.dir as string) || process.cwd();
  const config = loadConfig(projectDir);
  const urlOverride = (args.flags.url as string) || config.url;

  switch (command) {
    case 'login': {
      const url = urlOverride || process.env.ALMYTY_URL || 'https://api.almyty.com';
      await login(url);
      break;
    }

    case 'logout': {
      logout();
      break;
    }

    case 'gateways': {
      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);
      const gateways = await client.listGateways();

      if (gateways.length === 0) {
        console.log('No gateways found. Create one at https://app.almyty.com/gateways');
        return;
      }

      console.log('\nYour gateways:\n');
      for (const gw of gateways) {
        const slug = gw.name.toLowerCase().replace(/\s+/g, '-');
        console.log(`  ${gw.name}`);
        console.log(`    Type: ${gw.type}`);
        console.log(`    Use:  npx @almyty/skills install @<org>/${slug}`);
        console.log('');
      }
      break;
    }

    case 'list': {
      const ref = getRef(args);
      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);

      if (!ref) {
        const allSkills = await client.fetchAllSkills();
        if (!allSkills || (allSkills as any[]).length === 0) {
          console.log('No skills available. Assign tools to your gateways first.');
          return;
        }
        console.log(`\n${(allSkills as any[]).length} skills available:\n`);
        for (const skill of allSkills as any[]) {
          const label = skill.gateway ? `@${skill.orgSlug}/${skill.gatewaySlug}/${skill.name}` : skill.name;
          const desc = skill.description ? ` — ${skill.description}` : '';
          console.log(`  ${label}${desc}`);
        }
        return;
      }

      const parsed = parseRef(ref);
      if (parsed.type === 'gateway' || parsed.type === 'uuid') {
        const skills = await client.fetchSkills(ref);
        if (skills.length === 0) {
          console.log('No skills available. Assign tools to your gateway first.');
          return;
        }
        console.log(`\n${skills.length} skills available:\n`);
        for (const skill of skills) {
          console.log(`  ${skill.name}`);
        }
        console.log(`\nInstall: npx @almyty/skills install ${ref}`);
      } else {
        const allSkills = await client.fetchAllSkills();
        if (!allSkills || (allSkills as any[]).length === 0) {
          console.log('No skills available.');
          return;
        }
        console.log(`\n${(allSkills as any[]).length} skills available:\n`);
        for (const skill of allSkills as any[]) {
          const label = skill.gateway ? `@${skill.orgSlug}/${skill.gatewaySlug}/${skill.name}` : skill.name;
          const desc = skill.description ? ` — ${skill.description}` : '';
          console.log(`  ${label}${desc}`);
        }
      }
      break;
    }

    case 'search': {
      const query = getRef(args) || args.positional[0];
      if (!query) {
        console.error('Error: search query required');
        console.error('  npx @almyty/skills search <query>');
        process.exit(1);
      }

      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);
      const results = await client.searchSkills(query);

      if (!results || results.length === 0) {
        console.log(`No skills found for "${query}".`);
        return;
      }

      console.log(`\nFound ${results.length} skill(s):\n`);
      for (const skill of results) {
        const label = skill.skillRef || skill.toolName || skill.name;
        const desc = skill.toolDescription ? ` — ${skill.toolDescription}` : '';
        console.log(`  ${label}${desc}`);
      }
      console.log(`\nInstall: npx @almyty/skills install <ref>`);
      console.log(`Run:     npx @almyty/skills run <ref>`);
      break;
    }

    case 'install': {
      const ref = requireRef(args, 'install');
      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);
      const parsed = parseRef(ref);

      let skills: { name: string; fileName: string; content: string }[] = [];
      let gwName = ref;

      if (parsed.type === 'gateway' || parsed.type === 'uuid') {
        console.log('Fetching skills...');
        const [gateway, fetched] = await Promise.all([
          client.fetchGateway(ref).catch(() => null),
          client.fetchSkills(ref),
        ]);
        skills = fetched;
        gwName = gateway?.name || ref;
      } else if (parsed.type === 'skill') {
        console.log('Fetching skill...');
        const gatewayRef = `@${parsed.orgSlug}/${parsed.gatewaySlug}`;
        const fetched = await client.fetchSkills(gatewayRef);
        const match = fetched.find(s =>
          s.name === parsed.skillName ||
          s.fileName === `almyty-${parsed.skillName}`
        );
        if (!match) {
          console.error(`Skill "${parsed.skillName}" not found in ${gatewayRef}`);
          const available = fetched.map(s => s.name).join(', ');
          if (available) console.error(`Available: ${available}`);
          process.exit(1);
        }
        skills = [match];
        gwName = `${gatewayRef}/${parsed.skillName}`;
      } else if (parsed.type === 'search') {
        console.log(`Searching for "${ref}"...`);
        const results = await client.searchSkills(ref);
        if (!results || results.length === 0) {
          console.error(`No skills found for "${ref}".`);
          process.exit(1);
        }
        if (results.length === 1) {
          const match = results[0];
          const fetched = await client.fetchSkills(match.gatewayId);
          const toolSlug = match.toolName?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const skill = fetched.find((s: any) => s.name === toolSlug || s.name === match.toolName);
          if (skill) {
            skills = [skill];
            gwName = match.skillRef || match.toolName;
          } else {
            skills = fetched;
            gwName = match.gatewayName;
          }
        } else {
          console.log(`\nMultiple matches for "${ref}":\n`);
          for (const r of results) {
            const label = r.skillRef || r.toolName;
            const desc = r.toolDescription ? ` — ${r.toolDescription}` : '';
            console.log(`  ${label}${desc}`);
          }
          console.log(`\nBe more specific: npx @almyty/skills install @org/gateway/skill`);
          return;
        }
      }

      if (skills.length === 0) {
        console.log('No skills found.');
        return;
      }

      console.log(`\n${gwName} (${skills.length} skill(s))`);

      const targets = resolveTargets(projectDir, config);
      const results = targets.map(target => installSkills(skills, target));

      console.log('');
      for (const result of results) {
        console.log(`  ${result.agent}: ${result.installed} skills -> ${result.skillsDir}`);
      }

      const totalInstalled = results.reduce((sum, r) => sum + r.installed, 0);
      console.log(`\nInstalled ${totalInstalled} skill files across ${results.length} agent(s).`);
      console.log('Skills will be automatically loaded by your AI coding agent.');
      break;
    }

    case 'run': {
      const ref = requireRef(args, 'run');
      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);
      const parsed = parseRef(ref);

      let gatewayId: string;
      let toolId: string;

      if (parsed.type === 'skill' && parsed.orgSlug && parsed.gatewaySlug && parsed.skillName) {
        const gateway = await client.resolveGateway(parsed.orgSlug, parsed.gatewaySlug);
        gatewayId = gateway.id;
        toolId = parsed.skillName;
      } else if (parsed.type === 'search') {
        const results = await client.searchSkills(ref);
        if (!results || results.length === 0) {
          console.error(`No skill found for "${ref}".`);
          process.exit(1);
        }
        if (results.length > 1) {
          console.error(`Multiple matches for "${ref}". Be more specific:`);
          for (const r of results) {
            console.error(`  ${r.skillRef || r.toolName}`);
          }
          process.exit(1);
        }
        gatewayId = results[0].gatewayId;
        toolId = results[0].toolId;
      } else {
        console.error('Error: run requires a skill reference (@org/gateway/skill or skill-name)');
        process.exit(1);
      }

      const params = parseRunParams(args);
      const result = await client.executeSkill(gatewayId, toolId, params);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'daemon': {
      const intervalSec = parseInt(args.flags.interval as string, 10) || config.interval || 60;
      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);

      const targets = resolveTargets(projectDir, config);
      if (targets.length === 0) {
        console.error('No agent targets found.');
        process.exit(1);
      }

      console.log(`almyty skill daemon (every ${intervalSec}s)`);
      console.log(`Syncing to ${targets.length} agent target(s):`);
      for (const t of targets) {
        console.log(`  ${t.name}: ${t.skillsDir}`);
      }
      console.log('\nPress Ctrl+C to stop.\n');

      let lastHash = '';

      const sync = async () => {
        try {
          const allSkills = await client.fetchAllSkills();
          const metaSkill = generateMetaSkill();
          const skills = [metaSkill, ...(allSkills || [])];

          const currentHash = skills.map(s => `${s.name}:${s.content.length}`).join('|');

          if (currentHash !== lastHash) {
            lastHash = currentHash;
            const ts = new Date().toLocaleTimeString();

            for (const target of targets) {
              installSkills(skills, target);
            }
            console.log(`[${ts}] Synced ${skills.length} skills to ${targets.length} agent(s).`);
          }
        } catch (err: any) {
          const ts = new Date().toLocaleTimeString();
          console.error(`[${ts}] Sync error: ${err.message}`);
        }
      };

      await sync();

      const interval = setInterval(sync, intervalSec * 1000);

      const shutdown = () => {
        clearInterval(interval);
        console.log('\nDaemon stopped.');
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
      break;
    }

    case 'installed': {
      const targets = resolveTargets(projectDir, config);

      let totalFound = 0;
      for (const target of targets) {
        const installed = listInstalledSkills(target);
        if (installed.length > 0) {
          console.log(`\n${target.name} (${target.skillsDir}):`);
          for (const name of installed) {
            console.log(`  ${name}`);
          }
          totalFound += installed.length;
        }
      }

      if (totalFound === 0) {
        console.log('No almyty skills installed in this directory.');
        console.log('Install: npx @almyty/skills install @<org>/<gateway>');
      }
      break;
    }

    case 'remove': {
      const targets = resolveTargets(projectDir, config);

      let totalRemoved = 0;
      for (const target of targets) {
        const removed = removeSkills(target);
        if (removed > 0) {
          console.log(`  Removed ${removed} skills from ${target.skillsDir}`);
          totalRemoved += removed;
        }
      }

      if (totalRemoved === 0) {
        console.log('No almyty skills found to remove.');
      } else {
        console.log(`\nRemoved ${totalRemoved} skill(s) total.`);
      }
      break;
    }

    case 'watch': {
      const ref = requireRef(args, 'watch');
      const intervalSec = parseInt(args.flags.interval as string, 10) || config.interval || 60;
      const { url, token } = resolveAuth();
      const client = new AlmytyClient(urlOverride || url, token);

      const gateway = await client.fetchGateway(ref).catch(() => null);
      const gwName = gateway?.name || ref;

      const targets = getAllTargets(projectDir);

      console.log(`Watching ${gwName} (every ${intervalSec}s)`);
      console.log(`Syncing to ${targets.length} agent target(s):`);
      for (const t of targets) {
        console.log(`  ${t.name}: ${t.skillsDir}`);
      }
      console.log('\nPress Ctrl+C to stop.\n');

      let lastHash = '';

      const sync = async () => {
        try {
          const skills = await client.fetchSkills(ref);
          const currentHash = skills.map(s => `${s.name}:${s.content.length}`).join('|');

          if (currentHash !== lastHash) {
            lastHash = currentHash;
            const ts = new Date().toLocaleTimeString();

            if (skills.length === 0) {
              console.log(`[${ts}] No skills available.`);
              return;
            }

            for (const target of targets) {
              installSkills(skills, target);
            }
            console.log(`[${ts}] Synced ${skills.length} skills to ${targets.length} agent(s).`);
          }
        } catch (err: any) {
          const ts = new Date().toLocaleTimeString();
          console.error(`[${ts}] Sync error: ${err.message}`);
        }
      };

      await sync();

      const interval = setInterval(sync, intervalSec * 1000);

      const shutdown = () => {
        clearInterval(interval);
        console.log('\nWatch stopped.');
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
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
