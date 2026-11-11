// Summary statistics and the results.md tables, from results.json.

export function stats(values) {
  if (!values.length) return { n: 0, min: null, median: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { n: s.length, min: s[0], median, max: s[s.length - 1] };
}

const fmt = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const sec = (ms) => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
const ratio = (a, b) => (a && b ? `${(a / b).toFixed(1)}x` : 'n/a');

/** The markdown tables for results.md. */
export function renderTables(results) {
  const lines = [];
  lines.push('### Tool definitions in context before the first turn (o200k_base tokens)', '');
  lines.push('| API | operations | tools | (a) plain MCP tools/list | (b1) skill-first proxy, all 13 tools | (b2) proxy, its 2 gateway tools only | (b3) code-mode gateway (search_tools, get_tool, run_code) | (a) / (b3) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results.specs) {
    const t = r.tokens;
    lines.push(`| ${r.label} | ${fmt(r.operations)} | ${fmt(r.toolCount)} | ${fmt(t.full.initial)} | ${fmt(t.proxy.initialAll)} | ${fmt(t.proxy.initialGatewayOnly)} | ${fmt(t.code.initial)} | ${ratio(t.full.initial, t.code.initial)} |`);
  }
  lines.push('', '### One fixed task: tokens in context at the final call, and input summed over turns', '');
  lines.push('| API | task | plain MCP: final / summed (turns) | code mode: final / summed (turns) | proxy, no skill: final / summed (turns) | proxy + skill prompt: final / summed (turns) |');
  lines.push('|---|---|---|---|---|---|');
  const cell = (x) => (x ? `${fmt(x.finalContext)} / ${fmt(x.cumulativeInput)} (${x.turns})` : 'n/a');
  for (const r of results.specs) {
    const t = r.task;
    lines.push(`| ${r.label} | ${t.what} | ${cell(t.full)} | ${cell(t.code)} | ${cell(t.proxyNoSkill)} | ${cell(t.proxyWithSkill)} |`);
  }
  lines.push('', '### Discovery: did the search find the task\'s tool?', '');
  lines.push('| API | target tool | code mode search_tools (query: rank in top 10) | proxy almyty_search (keyword: in the 20 shown) | get_tool result | skill prompt |');
  lines.push('|---|---|---|---|---:|---:|');
  for (const r of results.specs) {
    const t = r.task;
    const code = (t.code.searches ?? []).map((s) => `"${s.query}": ${s.rank ?? 'not found'}`).join('; ');
    const proxy = (t.proxyNoSkill.searches ?? []).map((s) => `"${s.query}": ${s.found ? 'found' : 'not found'}`).join('; ');
    lines.push(`| ${r.label} | \`${r.targetTool}\` | ${code} | ${proxy} | ${fmt(t.code.getToolResultTokens)} | ${fmt(t.proxyWithSkill.skillPromptTokens)} |`);
  }
  lines.push('', '### Import to usable tools (wall clock, local stack)', '');
  lines.push('| API | description size | runs | min | median | max | tools generated |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of results.specs) {
    const s = r.import.stats;
    lines.push(`| ${r.label} | ${fmt(Math.round(r.bytes / 1024))} KiB | ${s.n} | ${sec(s.min)} | ${sec(s.median)} | ${sec(s.max)} | ${fmt(r.toolCount)} |`);
  }
  return lines.join('\n');
}
