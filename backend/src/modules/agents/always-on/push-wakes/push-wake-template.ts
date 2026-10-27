/**
 * The small template and path language push wakes are written in
 * (push-wake.types.ts). Deliberately tiny: `{{a.b}}` placeholders, and
 * paths with `.key`, `[0]`, `[*]` (every element) and `[key=value]` (the
 * elements whose key is value). No expressions, no code.
 */

// A placeholder's path is trimmed where it is read; no quantifier here can backtrack.
const PLACEHOLDER = /\{\{([^{}]{1,300})\}\}/g;
const WHOLE = /^\{\{([^{}]{1,300})\}\}$/;

type Step = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'all' } | { kind: 'where'; key: string; value: string };

function parse(path: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      const close = path.indexOf(']', i + 1);
      if (close < 0) break;
      const inner = path.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === '*') steps.push({ kind: 'all' });
      else if (/^\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) });
      else if (inner.includes('=')) {
        const at = inner.indexOf('=');
        steps.push({ kind: 'where', key: inner.slice(0, at).trim(), value: inner.slice(at + 1).trim() });
      } else steps.push({ kind: 'key', key: inner });
      continue;
    }
    let end = i;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') end++;
    steps.push({ kind: 'key', key: path.slice(i, end) });
    i = end;
  }
  return steps;
}

/** Every value at `path` (a list because `[*]` and `[key=value]` can match many). */
export function selectAll(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const step of parse(path)) {
    const next: unknown[] = [];
    for (const v of current) {
      if (v === null || v === undefined) continue;
      if (step.kind === 'key') {
        if (typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, step.key)) {
          next.push((v as Record<string, unknown>)[step.key]);
        }
      } else if (step.kind === 'index') {
        if (Array.isArray(v) && step.index < v.length) next.push(v[step.index]);
      } else if (step.kind === 'all') {
        if (Array.isArray(v)) next.push(...v);
      } else if (Array.isArray(v)) {
        for (const e of v) {
          if (e && typeof e === 'object' && String((e as Record<string, unknown>)[step.key]) === step.value) next.push(e);
        }
      }
    }
    current = next;
  }
  return current.filter((v) => v !== undefined);
}

/** The first value at `path`, or undefined. */
export function selectOne(value: unknown, path: string | null | undefined): unknown {
  if (!path) return undefined;
  return selectAll(value, path)[0];
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * A template filled in from `context`. A string that is exactly one
 * placeholder keeps the value's own type (a number stays a number, a
 * missing value is undefined, so an argument with nothing to say is left
 * out); placeholders inside text become text.
 */
export function render(template: unknown, context: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = WHOLE.exec(template);
    if (whole) return selectOne(context, whole[1].trim());
    return template.replace(PLACEHOLDER, (_m, path: string) => scalar(selectOne(context, path.trim())));
  }
  if (Array.isArray(template)) {
    return template.map((t) => render(t, context)).filter((v) => v !== undefined && v !== '');
  }
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      const value = render(v, context);
      if (value === undefined) continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length && v && typeof v === 'object' && Object.keys(v).length) continue;
      out[k] = value;
    }
    return out;
  }
  return template;
}

/** A template rendered as text. */
export function renderText(template: string, context: Record<string, unknown>): string {
  return scalar(render(template, context));
}

/** A time an answer gives, as a Date: milliseconds or seconds since 1970 (number or digits), or an ISO time. */
export function parseExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n > 1e12 ? n : n * 1000);
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
