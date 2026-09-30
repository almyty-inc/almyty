import { BadRequestException } from '@nestjs/common';

/**
 * Label requirements: the `key=value` pairs a piece of work asks of the
 * machine it runs on (`os=mac`, `gpu=yes`). A runner carries labels its
 * owner set; work that names requirements goes only to an online runner
 * whose labels include every one of them.
 *
 * Keys and values compare trimmed and case-insensitively, so `OS=Mac`
 * asks for the same machine as `os=mac`. A runner may carry more labels
 * than the work asks for; it may not carry fewer.
 */
export type LabelRequirements = Record<string, string>;

const MAX_REQUIREMENTS = 20;
const MAX_PART_LENGTH = 64;

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Read requirements from what a caller sent: an object (`{ gpu: 'yes' }`)
 * or the text a person types (`os=mac, gpu=yes`). Empty or absent is no
 * requirement at all. Anything that is not a list of key=value pairs is a
 * 400 that says which part is wrong.
 */
export function parseLabelRequirements(input: unknown): LabelRequirements {
  if (input === undefined || input === null || input === '') return {};
  const pairs: Array<[string, string]> = [];
  if (typeof input === 'string') {
    for (const part of input.split(/[,\n]/)) {
      const piece = part.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0 || eq === piece.length - 1) {
        throw new BadRequestException(`"${piece}" is not a label: write it as key=value, for example gpu=yes`);
      }
      pairs.push([piece.slice(0, eq), piece.slice(eq + 1)]);
    }
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new BadRequestException(`label ${k} needs a text value, for example ${k}=yes`);
      }
      pairs.push([k, String(v)]);
    }
  } else {
    throw new BadRequestException('labels are key=value pairs, for example os=mac, gpu=yes');
  }
  if (pairs.length > MAX_REQUIREMENTS) {
    throw new BadRequestException(`at most ${MAX_REQUIREMENTS} labels can be required`);
  }
  const out: LabelRequirements = {};
  for (const [rawKey, rawValue] of pairs) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      throw new BadRequestException(`"${rawKey}=${rawValue}" is not a label: both sides need text, for example gpu=yes`);
    }
    if (key.length > MAX_PART_LENGTH || value.length > MAX_PART_LENGTH) {
      throw new BadRequestException(`label ${key} is longer than ${MAX_PART_LENGTH} characters`);
    }
    out[key] = value;
  }
  return out;
}

/** Does a runner carrying `labels` satisfy every requirement? No requirements: yes. */
export function labelsMatch(
  labels: Record<string, unknown> | null | undefined,
  required: LabelRequirements | null | undefined,
): boolean {
  const wanted = Object.entries(required ?? {});
  if (wanted.length === 0) return true;
  const have = new Map<string, string>();
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (v === undefined || v === null) continue;
    have.set(norm(k), norm(String(v)));
  }
  return wanted.every(([k, v]) => have.get(norm(k)) === norm(v));
}

export function hasLabelRequirements(required: LabelRequirements | null | undefined): required is LabelRequirements {
  return !!required && Object.keys(required).length > 0;
}

/** `os=mac, gpu=yes`, in the order they were asked for. */
export function describeLabelRequirements(required: LabelRequirements): string {
  return Object.entries(required).map(([k, v]) => `${k}=${v}`).join(', ');
}

/** What a dispatch says when nothing qualifies. */
export function noMatchingRunnerMessage(required: LabelRequirements): string {
  return `No machine with ${describeLabelRequirements(required)} is online`;
}
