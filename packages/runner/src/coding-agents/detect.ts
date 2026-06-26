/**
 * Detect which coding-agent platforms are installed on this machine.
 *
 * Probes each platform's binary (and any aliases — e.g. cursor resolves via
 * `cursor-agent` or `agent`) using the same version-probe the runtime catalog
 * uses, then returns the available platforms with their capabilities. This is
 * what makes the runner report "I can drive claude, codex, gemini here" to the
 * backend at registration, instead of just a flat binary map.
 */
import { probe, realExec, type ProbeExec } from '../binaries.js';
import { listCodingAgents } from './registry.js';
import type { DetectedCodingAgent } from './types.js';

export async function detectCodingAgents(exec: ProbeExec = realExec): Promise<DetectedCodingAgent[]> {
  const results = await Promise.all(
    listCodingAgents().map(async (spec) => {
      // Probe the primary binary first, then aliases; first hit wins.
      for (const name of [spec.binary, ...spec.binaryAliases]) {
        const version = await probe(name, exec);
        if (version !== null) {
          const detected: DetectedCodingAgent = {
            id: spec.id,
            displayName: spec.displayName,
            binary: spec.binary,
            resolvedBinary: name,
            version,
            providerFamily: spec.providerFamily,
            supportsMcp: spec.supportsMcp,
            canManage: spec.canManage,
          };
          return detected;
        }
      }
      return null;
    }),
  );
  return results.filter((r): r is DetectedCodingAgent => r !== null);
}
