// Medians with their spread (25th to 75th percentile) per model and mode,
// overall and per task kind, as the design's benchmark section asks.

export function quantile(values, q) {
  const v = [...values].sort((a, b) => a - b)
  if (!v.length) return null
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return v[lo] + (v[hi] - v[lo]) * (pos - lo)
}

const METRICS = ['inputTokens', 'outputTokens', 'latencyMs', 'turns', 'toolCalls', 'metaCalls', 'scripts', 'apiCalls', 'costUsd']

function stats(rows) {
  const out = { runs: rows.length, successRate: rows.length ? rows.filter((r) => r.ok).length / rows.length : null }
  for (const m of METRICS) {
    const v = rows.map((r) => r[m])
    out[m] = { median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75) }
  }
  return out
}

export function summarize(rows) {
  const groups = new Map()
  for (const r of rows) {
    for (const key of [`${r.model}|${r.mode}|all`, `${r.model}|${r.mode}|${r.kind}`]) {
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
  }
  return [...groups.entries()].map(([key, g]) => {
    const [model, mode, kind] = key.split('|')
    return { model, mode, kind, ...stats(g) }
  })
}

const fmt = (s, digits = 0) =>
  s.median === null ? '-' : `${s.median.toFixed(digits)} (${s.p25.toFixed(digits)}–${s.p75.toFixed(digits)})`

export function markdownReport(meta, summary) {
  const lines = [
    `# Tool-mode benchmark, ${meta.date.slice(0, 10)}`,
    '',
    `Models: ${meta.models.join(', ')}. Modes: ${meta.modes.join(', ')}. ${meta.reps} runs per task, mode and model. ${meta.tools} tools over three APIs.`,
    '',
    'Each cell is the median per run, with the 25th to 75th percentile in brackets.',
    '',
  ]
  const kinds = [...new Set(summary.map((s) => s.kind))]
  for (const kind of ['all', ...kinds.filter((k) => k !== 'all')]) {
    lines.push(`## ${kind === 'all' ? 'All tasks' : kind}`, '')
    lines.push('| Model | Mode | Runs | Success | Input tokens | Output tokens | Latency (s) | Turns | Tool calls | Meta calls | Scripts | API calls | Cost (USD) |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const s of summary.filter((x) => x.kind === kind)) {
      const sec = { median: s.latencyMs.median / 1000, p25: s.latencyMs.p25 / 1000, p75: s.latencyMs.p75 / 1000 }
      lines.push(
        `| ${s.model} | ${s.mode} | ${s.runs} | ${Math.round(s.successRate * 100)}% | ${fmt(s.inputTokens)} | ${fmt(s.outputTokens)} | ${fmt(sec, 1)} | ${fmt(s.turns)} | ${fmt(s.toolCalls)} | ${fmt(s.metaCalls)} | ${fmt(s.scripts)} | ${fmt(s.apiCalls)} | ${fmt(s.costUsd, 4)} |`,
      )
    }
    lines.push('')
  }
  lines.push('Tasks:', '', ...meta.tasks.map((t) => `- ${t}`), '')
  return lines.join('\n')
}
