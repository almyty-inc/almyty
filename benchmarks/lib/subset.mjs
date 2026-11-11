// Cut an OpenAPI 3 description down to the operations carrying one tag,
// keeping only the components those operations reach. Deterministic: the
// same input gives byte-identical output, so its checksum can be recorded.

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Every `$ref` string under a value. */
export function collectRefs(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') into.add(v);
      else collectRefs(v, into);
    }
  }
  return into;
}

/** Resolve a local `#/a/b` pointer in a document; undefined when it does not resolve. */
export function resolvePointer(doc, ref) {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((cur, key) => (cur == null ? undefined : cur[key]), doc);
}

/** Count the operations of a description (one per path + method). */
export function countOperations(spec) {
  let n = 0;
  for (const item of Object.values(spec.paths ?? {})) {
    for (const m of METHODS) if (item && item[m]) n++;
  }
  return n;
}

/**
 * The description reduced to the operations tagged `tag`. Path-level
 * parameters stay with a path that keeps at least one operation; components
 * are kept only when reachable (transitively) from what remains.
 */
export function subsetByTag(spec, tag) {
  const paths = {};
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const kept = {};
    for (const m of METHODS) {
      if (item[m] && (item[m].tags ?? []).includes(tag)) kept[m] = item[m];
    }
    if (Object.keys(kept).length === 0) continue;
    for (const [k, v] of Object.entries(item)) if (!METHODS.includes(k)) kept[k] = v;
    paths[path] = kept;
  }

  // Walk references from the kept paths until nothing new turns up. A
  // pointer into a component (`#/components/schemas/x/properties/y`) keeps
  // the whole component.
  const rootOf = (ref) => {
    const parts = ref.split('/');
    return parts[0] === '#' && parts[1] === 'components' && parts.length > 4 ? parts.slice(0, 4).join('/') : ref;
  };
  const reached = new Set();
  const queue = [...collectRefs(paths)].map(rootOf);
  while (queue.length) {
    const ref = queue.pop();
    if (reached.has(ref)) continue;
    reached.add(ref);
    const target = resolvePointer(spec, ref);
    if (target !== undefined) queue.push(...[...collectRefs(target)].map(rootOf));
  }

  const components = {};
  for (const ref of [...reached].sort()) {
    const parts = ref.split('/');
    if (parts[0] !== '#' || parts[1] !== 'components' || parts.length !== 4) continue;
    const [, , section, name] = parts;
    const target = resolvePointer(spec, ref);
    if (target === undefined) continue;
    (components[section] ??= {})[name.replace(/~1/g, '/').replace(/~0/g, '~')] = target;
  }

  // Security schemes are named by `security`, not referenced: keep them all.
  if (spec.components?.securitySchemes) components.securitySchemes = spec.components.securitySchemes;
  const out = { ...spec, paths };
  if (Object.keys(components).length) out.components = components;
  else delete out.components;
  // Tags list, if any, shrinks to the one tag.
  if (Array.isArray(spec.tags)) out.tags = spec.tags.filter((t) => t.name === tag);
  delete out['x-webhooks'];
  delete out.webhooks;
  return out;
}
