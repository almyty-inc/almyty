/**
 * Remove every `<...>` span from a string: what `s.replace(/<[^>]*>/g, '')`
 * does (or `/<[^>]+>/g` with `allowEmpty: false`), in one pass.
 *
 * The regex is quadratic on an unclosed `<`. Each `<` scans to the end of
 * the input looking for a `>` before the engine gives up and tries the
 * next one, so 100 KB of `<` (the default JSON body limit) held the event
 * loop for six seconds. It ran in DTO transforms, before validation and
 * on registration before any sign-in, and on inbound email before the
 * gateway is known.
 *
 * Same result as the regex: a `<` with no `>` after it is kept, and so is
 * everything after it, because no later `<` can have a `>` either.
 */
export function stripTags(value: string, options: { allowEmpty?: boolean } = {}): string {
  const allowEmpty = options.allowEmpty !== false;
  let out = '';
  let kept = 0;
  let at = 0;
  for (;;) {
    const lt = value.indexOf('<', at);
    if (lt === -1) break;
    const gt = value.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1 && !allowEmpty) {
      at = lt + 1;
      continue;
    }
    out += value.slice(kept, lt);
    kept = at = gt + 1;
  }
  return out + value.slice(kept);
}

/** class-transformer `@Transform` for free-text fields: tags out, ends trimmed. */
export const stripHtmlTransform = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? stripTags(value).trim() : value;
