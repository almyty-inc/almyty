#!/usr/bin/env node
/**
 * Multi-vendor coding-agent fleet demo.
 *
 * Shows what the runner's coding-agent support gives you on a real machine:
 *   1. detect every coding CLI installed on this host (the fleet inventory)
 *   2. drive one of them through the runner's real PTY surface (proving the
 *      runner actually executes the real binary, not a stub)
 *
 * Run from packages/runner after `npm run build`:
 *   node examples/fleet-demo.mjs
 *
 * This is the orchestration substrate: an almyty agent (or any caller) uses
 * agent.spawn to launch a CLI as an unattended member and agent.status to watch
 * it (busy / idle / awaiting_input / awaiting_auth). The fan-out + watch-loop
 * policy lives in the calling agent; the runner provides the primitives.
 */
import { detectCodingAgents } from '../dist/coding-agents/index.js';

const pad = (s, n) => {
  s = String(s);
  // Truncate to n-2 + ellipsis, then pad — guarantees a 1-space column gap.
  return (s.length > n - 1 ? s.slice(0, n - 2) + '…' : s).padEnd(n);
};

async function main() {
  console.log('\n  almyty runner — coding-agent fleet on this host\n');

  const fleet = await detectCodingAgents();
  if (fleet.length === 0) {
    console.log('  (no coding CLIs detected on PATH)\n');
    return;
  }

  const W = { cli: 20, ver: 22, prov: 11, mcp: 5 };
  console.log(
    '  ' + pad('CLI', W.cli) + pad('VERSION', W.ver) + pad('PROVIDER', W.prov) +
      pad('MCP', W.mcp) + 'MANAGER',
  );
  console.log('  ' + '─'.repeat(W.cli + W.ver + W.prov + W.mcp + 7));
  for (const a of fleet) {
    console.log(
      '  ' + pad(a.displayName, W.cli) + pad(a.version, W.ver) + pad(a.providerFamily, W.prov) +
        pad(a.supportsMcp ? 'yes' : '—', W.mcp) + (a.canManage ? 'yes' : '—'),
    );
  }
  console.log(
    `\n  ${fleet.length} coding CLIs the runner can drive as unattended members ` +
      '(reported in runner.info → codingAgents).\n',
  );

  console.log('  Orchestrate the fleet over the agent.* surface:');
  console.log('    agent.spawn  { platform, apiKey, configDir } — launch a CLI as a member');
  console.log('                 (headless auth + isolated config home + auto-approve + resume)');
  console.log('    agent.status { processId } — classify its live pane:');
  console.log('                 busy / idle / awaiting_input / awaiting_auth / error\n');
  console.log('  Fan one task across vendors in parallel (Anthropic + OpenAI + Google), each in');
  console.log('  its own isolated home, and watch agent.status to drive the loop. See');
  console.log('  docs/coding-agents.md for the full multi-vendor orchestration walkthrough.\n');
}

main().catch((e) => {
  console.error('fleet demo failed:', e?.message ?? e);
  process.exit(1);
});
