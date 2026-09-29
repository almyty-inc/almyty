#!/usr/bin/env node

import { resolveCredentials } from './auth.js';
import { AlmytyClient, gatewayRefSlug, parseRef } from './client.js';
import { getAllTargets } from './agents.js';
import { installSkills, removeSkills, listInstalledSkills } from './installer.js';
import { loadConfig, resolveTargets } from './config.js';
import { generateMetaSkill } from './meta-skill.js';
import {
  selectInstallTargetsAuto,
  selectInstallTargetsInteractive,
} from './target-selector.js';
import { EXIT } from './exit-codes.js';
import { VERSION } from './version.js';
import { isInteractive } from './tty.js';
import { printHelp } from './help.js';
import {
  getRef,
  parseArgs,
  parseRunParams,
  type ParsedArgs,
} from './cli-args.js';

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function requireRef(args: ParsedArgs, command: string): string {
  const ref = getRef(args);
  if (!ref) {
    console.error('Error: reference required');
    console.error(`  npx @almyty/skills ${command} <org>/<gateway>`);
    console.error(`  npx @almyty/skills ${command} <skill-name>`);
    process.exit(EXIT.USAGE);
  }
  return ref;
}

/**
 * The credential, or the one instruction that fixes it.
 *
 * This used to call the shared resolver, which exits 1 — the same code
 * as an unexpected crash. Every almyty CLI answers a missing credential
 * with 3 so a script can retry the login instead of guessing.
 */
function requireAuth(args: ParsedArgs): { url: string; token: string } {
  const creds = resolveCredentials();
  if (!creds?.token) {
    if (args.flags.json) {
      emitJson({
        error: 'NOT_AUTHENTICATED',
        message: 'Run `npx @almyty/auth login`, or set ALMYTY_TOKEN.',
      });
    }
    console.error('Not authenticated. Run one of:');
    console.error('  npx @almyty/auth login');
    console.error('  export ALMYTY_TOKEN=<your-token>');
    process.exit(EXIT.AUTH);
  }
  return { url: creds.url, token: creds.token };
}

function newClient(args: ParsedArgs, urlOverride?: string): AlmytyClient {
  const { url, token } = requireAuth(args);
  return new AlmytyClient(urlOverride || url, token);
}

/** `org/gateway/skill — description`, the label used everywhere. */
function skillLabel(skill: any): string {
  if (skill.orgSlug && skill.gatewaySlug) {
    return `${skill.orgSlug}/${skill.gatewaySlug}/${skill.name}`;
  }
  return skill.skillRef || skill.name || skill.toolName;
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
  const json = args.flags.json === true;

  switch (command) {
    case 'login':
    case 'logout':
    case 'whoami': {
      // Auth has moved to its own dedicated package. Redirect rather
      // than silently doing nothing — users typing the old commands
      // should see the new entry point.
      console.error('Authentication moved to @almyty/auth.');
      console.error(`  npx @almyty/auth ${command}`);
      process.exit(EXIT.USAGE);
    }

    case 'gateways': {
      const client = newClient(args, urlOverride);
      const gateways = await client.listGateways();

      if (json) {
        emitJson(gateways);
        return;
      }
      if (gateways.length === 0) {
        console.log('No gateways found. Create one at https://app.almyty.com/gateways');
        return;
      }

      console.log('\nYour gateways:\n');
      for (const gw of gateways) {
        const slug = gatewayRefSlug(gw);
        console.log(`  ${gw.name}`);
        console.log(`    Type: ${gw.type}`);
        console.log(`    Use:  npx @almyty/skills install <org>/${slug}`);
        console.log('');
      }
      break;
    }

    case 'list': {
      const ref = getRef(args);
      const client = newClient(args, urlOverride);
      const parsed = ref ? parseRef(ref) : null;

      if (parsed && (parsed.type === 'gateway' || parsed.type === 'uuid')) {
        const skills = await client.fetchSkills(ref!);
        if (json) {
          emitJson(skills.map((s) => ({ name: s.name, fileName: s.fileName })));
          return;
        }
        if (skills.length === 0) {
          console.log('No skills available. Assign tools to your gateway first.');
          return;
        }
        console.log(`\n${skills.length} skills available:\n`);
        for (const skill of skills) console.log(`  ${skill.name}`);
        console.log(`\nInstall: npx @almyty/skills install ${ref}`);
        break;
      }

      // No ref, or a name that is not a gateway ref: list everything.
      const allSkills = (await client.fetchAllSkills()) as any[];
      if (json) {
        emitJson(
          allSkills.map((s) => ({
            ref: skillLabel(s),
            name: s.name,
            description: s.description ?? null,
            gateway: s.gateway ?? null,
            gatewayId: s.gatewayId ?? null,
            orgSlug: s.orgSlug ?? null,
            gatewaySlug: s.gatewaySlug ?? null,
          })),
        );
        return;
      }
      if (allSkills.length === 0) {
        console.log('No skills available. Assign tools to your gateways first.');
        return;
      }
      console.log(`\n${allSkills.length} skills available:\n`);
      for (const skill of allSkills) {
        const desc = skill.description ? ` — ${skill.description}` : '';
        console.log(`  ${skillLabel(skill)}${desc}`);
      }
      break;
    }

    case 'search': {
      const query = getRef(args) || args.positional[0];
      if (!query) {
        console.error('Error: search query required');
        console.error('  npx @almyty/skills search <query>');
        process.exit(EXIT.USAGE);
      }

      // Search is org-scoped: it looks through the gateways YOUR
      // account can see, so it needs a credential. There is no public
      // skill index to search without one.
      const client = newClient(args, urlOverride);
      const results = await client.searchSkills(query);

      if (json) {
        emitJson(
          (results ?? []).map((r: any) => ({
            ref: r.skillRef ?? null,
            name: r.toolName ?? r.name ?? null,
            description: r.toolDescription ?? null,
            gatewayId: r.gatewayId ?? null,
            gatewayName: r.gatewayName ?? null,
            toolId: r.toolId ?? null,
          })),
        );
        return;
      }
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
      console.log('\nInstall: npx @almyty/skills install <ref>');
      console.log('Run:     npx @almyty/skills run <ref>');
      break;
    }

    case 'install': {
      const ref = requireRef(args, 'install');
      const client = newClient(args, urlOverride);
      const parsed = parseRef(ref);
      const dryRun = args.flags['dry-run'] === true;

      let skills: { name: string; fileName: string; content: string }[] = [];
      let gwName = ref;

      if (parsed.type === 'gateway' || parsed.type === 'uuid') {
        if (!json) console.log('Fetching skills...');
        const [gateway, fetched] = await Promise.all([
          client.fetchGateway(ref).catch(() => null),
          client.fetchSkills(ref),
        ]);
        skills = fetched;
        gwName = gateway?.name || ref;
      } else if (parsed.type === 'skill') {
        if (!json) console.log('Fetching skill...');
        const gatewayRef = `${parsed.orgSlug}/${parsed.gatewaySlug}`;
        const fetched = await client.fetchSkills(gatewayRef);
        const match = fetched.find(
          (s) =>
            s.name === parsed.skillName ||
            s.fileName === `almyty-${parsed.skillName}` ||
            s.fileName === parsed.skillName,
        );
        if (!match) {
          console.error(`Skill "${parsed.skillName}" not found in ${gatewayRef}`);
          const available = fetched.map((s) => s.name).join(', ');
          if (available) console.error(`Available: ${available}`);
          process.exit(EXIT.NOT_FOUND);
        }
        skills = [match];
        gwName = `${gatewayRef}/${parsed.skillName}`;
      } else if (parsed.type === 'search') {
        if (!json) console.log(`Searching for "${ref}"...`);
        const results = await client.searchSkills(ref);
        if (!results || results.length === 0) {
          fail(`No skills found for "${ref}".`, EXIT.NOT_FOUND);
        }
        if (results.length === 1) {
          const match = results[0];
          const fetched = await client.fetchSkills(match.gatewayId);
          const toolSlug = match.toolName
            ?.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
          const skill = fetched.find(
            (s: any) => s.name === toolSlug || s.name === match.toolName,
          );
          if (skill) {
            skills = [skill];
            gwName = match.skillRef || match.toolName;
          } else {
            skills = fetched;
            gwName = match.gatewayName;
          }
        } else {
          // Ambiguous: refuse rather than guess, and exit non-zero so a
          // script does not treat "installed nothing" as success.
          if (json) {
            emitJson({
              error: 'AMBIGUOUS_REF',
              query: ref,
              matches: results.map((r: any) => r.skillRef || r.toolName),
            });
          } else {
            console.error(`\nMultiple matches for "${ref}":\n`);
            for (const r of results) {
              const label = r.skillRef || r.toolName;
              const desc = r.toolDescription ? ` — ${r.toolDescription}` : '';
              console.error(`  ${label}${desc}`);
            }
            console.error('\nBe more specific: npx @almyty/skills install org/gateway/skill');
          }
          process.exit(EXIT.USAGE);
        }
      }

      if (skills.length === 0) {
        fail('No skills found.', EXIT.NOT_FOUND);
      }

      const selection = {
        projectDir,
        config,
        agentFlag: args.flags.agent as string | string[] | undefined,
        pathFlag: args.flags.path as string | string[] | undefined,
        all: args.flags.all === true,
        // A dry run must never sit on a picker in a pipe, and --json has
        // no way to render one.
        yes: args.flags.yes === true || json,
        global: args.flags.global === true,
        interactive: isInteractive(),
      };
      let targets = selectInstallTargetsAuto(selection);
      if (targets === null) {
        // Interactive picker — TTY + no flags + no .almytyrc.
        targets = await selectInstallTargetsInteractive(selection);
      }

      if (targets.length === 0) {
        fail(
          'No install targets resolved. Pass --agent / --path / --all, or run without flags in a terminal.',
          EXIT.USAGE,
        );
      }

      // Say where, before writing. Installing edits directories an
      // editor reads on every session, so the paths belong on screen
      // whether or not the user asked for a dry run.
      if (!json) {
        console.log('');
        console.log(
          dryRun
            ? `${gwName} (${skills.length} skill(s)) — dry run, nothing will be written:`
            : `${gwName} (${skills.length} skill(s)) — installing to:`,
        );
        for (const target of targets) {
          console.log(`  ${target.name}: ${target.skillsDir}`);
        }
      }

      const results = targets.map((target) => installSkills(skills, target, { dryRun }));

      if (json) {
        emitJson({
          ref,
          gateway: gwName,
          dryRun,
          skills: skills.map((s) => s.name),
          targets: results.map((r) => ({
            agent: r.agent,
            skillsDir: r.skillsDir,
            installed: r.installed,
            skipped: r.skipped,
            overwritten: r.overwritten,
            files: r.files,
          })),
        });
        return;
      }

      const totalInstalled = results.reduce((sum, r) => sum + r.installed, 0);
      const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
      const totalOverwritten = results.reduce((sum, r) => sum + r.overwritten, 0);

      console.log('');
      for (const result of results) {
        console.log(
          `  ${result.agent}: ${result.installed} skill file(s) ${dryRun ? 'would go to' : '->'} ${result.skillsDir}`,
        );
        if (dryRun) for (const file of result.files) console.log(`      ${file}`);
      }

      console.log('');
      if (dryRun) {
        console.log(
          `Dry run: ${totalInstalled} skill file(s) across ${results.length} target(s), ${totalOverwritten} of them replacing an existing file.`,
        );
        console.log('Re-run without --dry-run to write them.');
      } else {
        console.log(
          `Installed ${totalInstalled} skill file(s) across ${results.length} target(s).`,
        );
        if (totalOverwritten > 0) {
          console.log(`${totalOverwritten} replaced a SKILL.md that was already there.`);
        }
        console.log('Your AI coding agent picks them up on its next session.');
      }
      // Said out loud: a skill refused for an unsafe name used to be
      // counted as installed, so the total was the number offered.
      if (totalSkipped > 0) {
        console.log(`${totalSkipped} skill(s) were skipped — see the warnings above.`);
      }
      break;
    }

    case 'run': {
      const ref = requireRef(args, 'run');
      const client = newClient(args, urlOverride);
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
          fail(`No skill found for "${ref}".`, EXIT.NOT_FOUND);
        }
        if (results.length > 1) {
          console.error(`Multiple matches for "${ref}". Be more specific:`);
          for (const r of results) console.error(`  ${r.skillRef || r.toolName}`);
          process.exit(EXIT.USAGE);
        }
        gatewayId = results[0].gatewayId;
        toolId = results[0].toolId;
      } else {
        fail(
          'Error: run needs a skill reference (org/gateway/skill, or a skill name)',
          EXIT.USAGE,
        );
      }

      const params = parseRunParams(args);
      const result = await client.executeSkill(gatewayId, toolId, params);
      // A skill's result IS data, so JSON is the default here rather
      // than an opt-in. --json is accepted and means the same thing.
      console.log(JSON.stringify(result, null, 2));
      // The gateway answers 200 with a body that reports the tool's own
      // failure, so the body decides the exit code.
      if (result && typeof result === 'object') {
        const body: any = result;
        const failed =
          body.success === false ||
          body.status === 'failed' ||
          body.status === 'error' ||
          (body.data && body.data.success === false);
        if (failed) process.exitCode = EXIT.FAILED;
      }
      break;
    }

    case 'installed': {
      const targets = resolveTargets(projectDir, config);
      const found: Array<{ agent: string; skillsDir: string; skills: string[] }> = [];

      for (const target of targets) {
        const installed = listInstalledSkills(target);
        if (installed.length > 0) {
          found.push({ agent: target.name, skillsDir: target.skillsDir, skills: installed });
        }
      }

      if (json) {
        emitJson(found);
        return;
      }
      if (found.length === 0) {
        console.log('No almyty skills installed in this directory.');
        console.log('Install: npx @almyty/skills install <org>/<gateway>');
        return;
      }
      for (const entry of found) {
        console.log(`\n${entry.agent} (${entry.skillsDir}):`);
        for (const name of entry.skills) console.log(`  ${name}`);
      }
      break;
    }

    case 'remove': {
      const targets = resolveTargets(projectDir, config);
      const removedPer: Array<{ agent: string; skillsDir: string; removed: number }> = [];

      for (const target of targets) {
        const removed = removeSkills(target);
        if (removed > 0) {
          removedPer.push({ agent: target.name, skillsDir: target.skillsDir, removed });
        }
      }
      const totalRemoved = removedPer.reduce((sum, r) => sum + r.removed, 0);

      if (json) {
        emitJson({ removed: totalRemoved, targets: removedPer });
        return;
      }
      if (totalRemoved === 0) {
        console.log('No almyty skills found to remove.');
        return;
      }
      for (const entry of removedPer) {
        console.log(`  Removed ${entry.removed} skill(s) from ${entry.skillsDir}`);
      }
      console.log(`\nRemoved ${totalRemoved} skill(s) total.`);
      break;
    }

    case 'daemon':
    case 'watch': {
      const intervalSec =
        parseInt(args.flags.interval as string, 10) || config.interval || 60;
      const client = newClient(args, urlOverride);
      const watchRef = command === 'watch' ? requireRef(args, 'watch') : null;

      const targets = watchRef
        ? getAllTargets(projectDir)
        : resolveTargets(projectDir, config);
      if (targets.length === 0) {
        fail('No agent targets found. Pass --agent or --path.', EXIT.USAGE);
      }

      let label = 'every skill';
      if (watchRef) {
        const gateway = await client.fetchGateway(watchRef).catch(() => null);
        label = gateway?.name || watchRef;
      }

      console.log(`almyty skill sync: ${label}, every ${intervalSec}s`);
      console.log(`Syncing to ${targets.length} target(s):`);
      for (const t of targets) console.log(`  ${t.name}: ${t.skillsDir}`);
      console.log('\nPress Ctrl+C to stop.\n');

      let lastHash = '';

      const sync = async () => {
        try {
          const fetched = watchRef
            ? await client.fetchSkills(watchRef)
            : [generateMetaSkill(), ...((await client.fetchAllSkills()) || [])];
          const currentHash = fetched
            .map((s) => `${s.name}:${s.content.length}`)
            .join('|');
          if (currentHash === lastHash) return;

          const ts = new Date().toLocaleTimeString();
          if (fetched.length === 0) {
            console.log(`[${ts}] No skills available.`);
            return;
          }

          let written = 0;
          for (const target of targets) {
            written += installSkills(fetched, target).installed;
          }
          // Only once the install actually happened. Stamping the hash
          // first meant a throw inside installSkills logged one "Sync
          // error" and then every later tick matched the hash and
          // printed nothing -- indistinguishable from "up to date".
          lastHash = currentHash;
          console.log(`[${ts}] Synced ${written} skill file(s) to ${targets.length} target(s).`);
        } catch (err: any) {
          const ts = new Date().toLocaleTimeString();
          console.error(`[${ts}] Sync error: ${err.message}`);
        }
      };

      await sync();
      const interval = setInterval(sync, intervalSec * 1000);

      const shutdown = () => {
        clearInterval(interval);
        console.log('\nStopped.');
        process.exit(EXIT.OK);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        'Commands: install, list, search, run, installed, remove, gateways, daemon, watch. Run --help for detail.',
      );
      process.exit(EXIT.USAGE);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  const authFailure = /Authentication failed|\(401\)|API error 401/.test(err.message ?? '');
  process.exit(authFailure ? EXIT.AUTH : EXIT.ERROR);
});
