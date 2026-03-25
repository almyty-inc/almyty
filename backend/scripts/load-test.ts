/**
 * Agent Load Test Script
 * Usage: npx ts-node scripts/load-test.ts --url https://api.staging.almyty.com --agent-id <id> --concurrency 10 --total 50
 *
 * Options:
 *   --url          Base URL of the API server (required)
 *   --agent-id     Agent UUID to invoke (required)
 *   --token        JWT bearer token (if not provided, will prompt for login)
 *   --email        Email for login (used if --token is not provided)
 *   --password     Password for login (used if --token is not provided)
 *   --concurrency  Number of parallel requests per batch (default: 10)
 *   --total        Total number of requests to fire (default: 50)
 *   --input        JSON string to use as agent input (default: {"message":"Hello"})
 */

import axios, { AxiosInstance } from 'axios';

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const url = args['url'];
const agentId = args['agent-id'];
let token = args['token'] || '';
const email = args['email'] || '';
const password = args['password'] || '';
const concurrency = parseInt(args['concurrency'] || '10', 10);
const total = parseInt(args['total'] || '50', 10);
const inputJson = args['input'] || '{"message":"Hello"}';

if (!url || !agentId) {
  console.error('Usage: npx ts-node scripts/load-test.ts --url <base-url> --agent-id <uuid> [--token <jwt>] [--email <email>] [--password <pass>] [--concurrency <n>] [--total <n>] [--input <json>]');
  process.exit(1);
}

let agentInput: Record<string, any>;
try {
  agentInput = JSON.parse(inputJson);
} catch {
  console.error('Invalid --input JSON:', inputJson);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RequestResult {
  success: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client: AxiosInstance = axios.create({
    baseURL: url,
    timeout: 120000,
    headers: { 'Content-Type': 'application/json' },
  });

  // Login if no token provided
  if (!token) {
    if (!email || !password) {
      console.error('No --token provided. Supply --email and --password for login, or provide --token directly.');
      process.exit(1);
    }
    console.log(`Logging in as ${email}...`);
    try {
      const loginRes = await client.post('/auth/login', { email, password });
      token = loginRes.data?.data?.token || loginRes.data?.token || loginRes.data?.access_token;
      if (!token) {
        console.error('Login succeeded but no token returned:', JSON.stringify(loginRes.data));
        process.exit(1);
      }
      console.log('Login successful.');
    } catch (err: any) {
      console.error('Login failed:', err.response?.data?.message || err.message);
      process.exit(1);
    }
  }

  client.defaults.headers.common['Authorization'] = `Bearer ${token}`;

  console.log('');
  console.log('=== Agent Load Test ===');
  console.log(`  URL:         ${url}`);
  console.log(`  Agent ID:    ${agentId}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Total:       ${total}`);
  console.log(`  Input:       ${JSON.stringify(agentInput)}`);
  console.log('');

  const results: RequestResult[] = [];
  let completed = 0;

  const overallStart = Date.now();

  // Fire in batches
  for (let batchStart = 0; batchStart < total; batchStart += concurrency) {
    const batchSize = Math.min(concurrency, total - batchStart);
    const batchPromises: Promise<RequestResult>[] = [];

    for (let i = 0; i < batchSize; i++) {
      batchPromises.push(
        (async (): Promise<RequestResult> => {
          const start = Date.now();
          try {
            const res = await client.post(`/agents/${agentId}/invoke`, {
              input: agentInput,
            });
            const latencyMs = Date.now() - start;
            completed++;
            process.stdout.write(`\r  Progress: ${completed}/${total}`);
            return { success: res.data?.success !== false, latencyMs, status: res.status };
          } catch (err: any) {
            const latencyMs = Date.now() - start;
            completed++;
            process.stdout.write(`\r  Progress: ${completed}/${total}`);
            return {
              success: false,
              latencyMs,
              status: err.response?.status,
              error: err.response?.data?.message || err.message,
            };
          }
        })(),
      );
    }

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  const overallTime = Date.now() - overallStart;

  // ── Compute stats ──────────────────────────────────────────────────────────

  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);

  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const minLatency = latencies[0] || 0;
  const maxLatency = latencies[latencies.length - 1] || 0;

  const rps = total > 0 ? (total / (overallTime / 1000)).toFixed(2) : '0';

  // ── Print summary ──────────────────────────────────────────────────────────

  console.log('\n');
  console.log('=== Load Test Results ===');
  console.log(`  Total Requests:  ${total}`);
  console.log(`  Successes:       ${successCount}`);
  console.log(`  Failures:        ${failureCount}`);
  console.log(`  Success Rate:    ${((successCount / total) * 100).toFixed(1)}%`);
  console.log('');
  console.log('  Latency:');
  console.log(`    Min:           ${minLatency}ms`);
  console.log(`    Avg:           ${avgLatency}ms`);
  console.log(`    P50:           ${p50}ms`);
  console.log(`    P95:           ${p95}ms`);
  console.log(`    P99:           ${p99}ms`);
  console.log(`    Max:           ${maxLatency}ms`);
  console.log('');
  console.log(`  Total Time:      ${(overallTime / 1000).toFixed(2)}s`);
  console.log(`  Throughput:      ${rps} req/s`);

  if (failureCount > 0) {
    console.log('');
    console.log('  Sample Errors:');
    const errors = results.filter(r => !r.success).slice(0, 5);
    for (const e of errors) {
      console.log(`    [${e.status || 'N/A'}] ${e.error || 'Unknown error'} (${e.latencyMs}ms)`);
    }
  }

  console.log('');
  console.log('=== Done ===');

  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Load test crashed:', err.message);
  process.exit(1);
});
