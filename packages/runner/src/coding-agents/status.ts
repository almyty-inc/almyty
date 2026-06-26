/**
 * Two-tier status detection — Tier 2 (VT scrape), ported from maco's
 * `state/patterns.rs` + `detector.rs`.
 *
 * When no fresh lifecycle signal is available, scrape the rendered terminal
 * screen for busy/prompt markers. Detection is BUSY-FIRST: a live
 * "esc to interrupt" marker or an active spinner glyph is authoritative; only
 * when NOT busy do we look at the prompt. Auth/error gates are checked before
 * the prompt so a member stuck on a sign-in screen reads as `awaiting_auth`,
 * not idle.
 *
 * The per-CLI markers are DATA (registry.ts → spec.status), so tuning a CLI is
 * a table edit. This module is the matcher only.
 */
import type { AgentStatus, StatusPatterns } from './types.js';

/** Spinner glyphs shared across most CLIs (verbatim from maco). */
export const SPINNER_GLYPHS = [
  '·', '✶', '✷', '✸', '✹', '★', '◐', '◓', '◑', '◒',
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
];

/** opencode adds a block-shaded pulse on top of the braille set. */
export const PULSE_GLYPHS = [...SPINNER_GLYPHS, '█', '▓', '▒', '░'];

/**
 * Cross-CLI auth-gate markers. A member stuck here is blocked on a human, not
 * working — surfaced as a distinct state so an orchestrator can inject a key or
 * answer the prompt rather than waiting forever. (maco's AwaitingAuth state.)
 */
export const AUTH_MARKERS = [
  'sign in to', 'sign in with', 'please log in', 'please sign in',
  'press enter to authenticate', 'press enter to login', 'paste your api key',
  'enter your api key', 'authentication required', 'select auth', 'how would you like to authenticate',
  'login with', '/login', 'terms of service', 'accept the terms', 'waiting for authentication',
];

/** Cross-CLI fatal-error markers. */
export const ERROR_MARKERS = [
  'panic:', 'fatal error', 'traceback (most recent call last)',
  'segmentation fault', 'command not found', 'econnrefused',
  'rate limit exceeded', 'quota exceeded', 'authentication failed',
  'invalid api key', 'unhandled exception',
];

/**
 * Strip VT/ANSI escape sequences so the classifier sees plain text. PTY output
 * is full of CSI color/cursor codes and OSC title sets; the markers we match
 * (prompts, "esc to interrupt") are plain characters underneath.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripVtEscapes(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Alt-screen TUIs (claude, gemini, …) repaint each frame from the top: an
 * erase-display or cursor-home sequence starts a fresh frame, so everything
 * before it on the previous frame is stale. Return the index in `s` where the
 * LAST such frame-reset begins, or -1 if there is none. The caller keeps only
 * the bytes from that point so a status line that has since been cleared (e.g.
 * "esc to interrupt") doesn't linger in an append log and falsely read busy.
 */
// eslint-disable-next-line no-control-regex
const FRAME_RESET_RE = /\x1b\[(?:2J|3J|H|1;1H|0;0H)/g;

export function lastFrameResetIndex(s: string): number {
  let idx = -1;
  for (const m of s.matchAll(FRAME_RESET_RE)) idx = m.index;
  return idx;
}

/** The last N non-blank lines of the screen — where prompts live. */
function tailLines(screen: string, n: number): string[] {
  const lines = screen.split('\n').map((l) => l.replace(/\r$/, ''));
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  return nonBlank.slice(-n);
}

function anyLineStartsWithSpinner(screen: string, glyphs: string[]): boolean {
  for (const raw of screen.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trimStart();
    if (trimmed.length > 0 && glyphs.includes(trimmed[0])) return true;
  }
  return false;
}

/**
 * Classify a rendered screen for one CLI. `screen` is the visible VT text
 * (already de-escaped to plain characters by the caller / process manager).
 *
 * Order: busy → auth → error → idle-prompt → unknown. Busy wins because a CLI
 * often keeps a prompt line on screen while working; the active-work marker is
 * the truth.
 */
export function classifyStatus(patterns: StatusPatterns, screen: string): AgentStatus {
  const lower = screen.toLowerCase();

  // ── Tier 2a: BUSY (authoritative) ──
  for (const sub of patterns.busySubstrings) {
    if (lower.includes(sub)) return 'busy';
  }
  if (anyLineStartsWithSpinner(screen, patterns.spinnerGlyphs)) return 'busy';

  // ── auth gate before prompt: a sign-in screen is not "idle" ──
  const tail = tailLines(screen, 12);
  const tailLower = tail.join('\n').toLowerCase();
  for (const m of AUTH_MARKERS) {
    if (tailLower.includes(m)) return 'awaiting_auth';
  }
  for (const m of ERROR_MARKERS) {
    if (lower.includes(m)) return 'error';
  }

  // ── Tier 2b: IDLE PROMPT ──
  const bottom = tailLines(screen, 3);
  for (const line of bottom) {
    const trimmedStart = line.trimStart();
    const trimmed = line.trim();
    if (patterns.promptExact.includes(trimmed)) return 'idle';
    if (patterns.promptPrefixes.some((p) => trimmedStart.startsWith(p))) return 'idle';
    if (patterns.promptContains.some((c) => line.includes(c))) return 'idle';
  }

  // No marker matched. The caller decides; for an actively-streaming pane this
  // usually means "still busy", but we don't assert it here.
  return 'unknown';
}
