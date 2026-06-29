/**
 * Coding-agent platform support for the runner — the orchestration substrate.
 *
 * Turns the runner's generic process surface into a fleet that KNOWS the
 * coding CLIs maco supports (claude, codex, gemini, cursor, opencode, crush,
 * copilot, grok, hermes, mistral_vibe, openclaw, + aider): detect them, build
 * an unattended spawn spec (headless auth + isolated config home + auto-approve
 * + resume), and classify each live pane's status (busy / idle / awaiting input
 * / awaiting auth / error).
 */
export {
  CODING_AGENTS,
  CODING_AGENT_IDS,
  listCodingAgents,
  getCodingAgent,
  findByBinary,
  allProbeBinaries,
} from './registry.js';
export { buildAgentSpawn, resumeArgv, type AgentSpawnInput } from './spawn-spec.js';
export {
  classifyStatus,
  stripVtEscapes,
  lastFrameResetIndex,
  SPINNER_GLYPHS,
  PULSE_GLYPHS,
  AUTH_MARKERS,
  ERROR_MARKERS,
} from './status.js';
export { detectCodingAgents } from './detect.js';
export type {
  CodingAgentId,
  CodingAgentSpec,
  DetectedCodingAgent,
  AgentStatus,
  StatusPatterns,
  SessionFlavor,
} from './types.js';
