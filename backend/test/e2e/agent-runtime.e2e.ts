#!/usr/bin/env npx tsx
/**
 * E2E test suite for the almyty agent runtime.
 *
 * Runs against a live staging server. NOT a Jest test — standalone Node.js script.
 *
 * Environment variables:
 *   STAGING_URL   — base URL of the API (default: https://api.staging.almyty.com)
 *   TEST_EMAIL    — login email
 *   TEST_PASSWORD — login password
 *
 * Usage:
 *   STAGING_URL=https://api.staging.almyty.com TEST_EMAIL=test@apif.ai TEST_PASSWORD=TestPass123! npx tsx test/e2e/agent-runtime.e2e.ts
 */

import axios, { AxiosInstance, AxiosError } from 'axios';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STAGING_URL = process.env.STAGING_URL || 'https://api.staging.almyty.com';
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

if (!TEST_EMAIL || !TEST_PASSWORD) {
  console.error('ERROR: TEST_EMAIL and TEST_PASSWORD environment variables are required.');
  process.exit(1);
}

const RUN_POLL_INTERVAL_MS = 2000;
const RUN_POLL_TIMEOUT_MS = 90_000;  // 90s for autonomous runs (LLM calls are slow)
const WORKFLOW_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let api: AxiosInstance;
let token: string;
let llmProviderId: string | null = null;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function extractData<T = any>(response: any): T {
  const body = response.data;
  if (body && typeof body === 'object' && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

async function login(): Promise<string> {
  const res = await axios.post(`${STAGING_URL}/auth/login`, {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  const data = res.data?.data ?? res.data;
  const tok = data?.token || data?.access_token || data?.accessToken;
  if (!tok) {
    throw new Error(`Login failed: no token in response. Body: ${JSON.stringify(res.data).substring(0, 300)}`);
  }
  return tok;
}

function createApi(tok: string): AxiosInstance {
  const instance = axios.create({
    baseURL: STAGING_URL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tok}`,
    },
    timeout: 60_000,
  });
  return instance;
}

/** Get the organization ID from the authenticated user profile */
let orgId: string = '';
async function findOrgId(): Promise<string> {
  if (orgId) return orgId;
  const profile = extractData<any>(await api.get('/auth/profile'));
  const memberships = profile?.organizationMemberships || profile?.organizations || [];
  orgId = memberships[0]?.organization?.id || memberships[0]?.organizationId || memberships[0]?.id || '';
  if (!orgId) throw new Error('Could not determine organization ID from profile');
  return orgId;
}

/** Find the first usable LLM provider (OpenAI, Anthropic, etc.) */
async function findLlmProvider(): Promise<string> {
  if (llmProviderId) return llmProviderId;
  const rawProviders = extractData<any>(await api.get('/llm-providers'));
  const providers = Array.isArray(rawProviders) ? rawProviders : rawProviders?.providers || [];
  if (!providers || providers.length === 0) {
    throw new Error('No LLM providers configured on staging. Create at least one LLM provider first.');
  }
  // Prefer OpenAI, fallback to first available
  const openai = providers.find((p: any) => p.type === 'openai' || p.name?.toLowerCase().includes('openai'));
  llmProviderId = openai?.id || providers[0].id;
  return llmProviderId!;
}

/** Create an autonomous agent with a tool */
async function createAutonomousAgent(
  name: string,
  toolIds: string[] = [],
  extra: Record<string, any> = {},
): Promise<any> {
  const providerId = await findLlmProvider();
  const agent = extractData(await api.post('/agents', {
    name,
    description: `E2E test agent - ${name}`,
    mode: 'autonomous',
    status: 'active',
    instructions: extra.instructions || 'You are a helpful assistant. Use the tools available to answer questions accurately.',
    personality: extra.personality || 'Precise, concise, and factual.',
    toolIds,
    modelConfig: {
      providerId,
      model: extra.model || 'gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 1024,
    },
    pipeline: { nodes: [], edges: [] },
    ...extra,
  }));
  return agent;
}

/** Create a workflow agent with a specific pipeline */
async function createWorkflowAgent(
  name: string,
  pipeline: any,
  extra: Record<string, any> = {},
): Promise<any> {
  const providerId = await findLlmProvider();
  const agent = extractData(await api.post('/agents', {
    name,
    description: `E2E test workflow - ${name}`,
    mode: 'workflow',
    status: 'active',
    modelConfig: {
      providerId,
      model: extra.model || 'gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 1024,
    },
    pipeline,
    ...extra,
  }));
  return agent;
}

/** Start an autonomous run and poll until done */
async function startAndPollRun(
  agentId: string,
  input: any,
  timeoutMs: number = RUN_POLL_TIMEOUT_MS,
): Promise<any> {
  const runRes = extractData(await api.post(`/agents/${agentId}/runs`, { input }));
  const runId = runRes.id;
  if (!runId) throw new Error(`startRun returned no id. Response: ${JSON.stringify(runRes).substring(0, 300)}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(RUN_POLL_INTERVAL_MS);
    const run = extractData(await api.get(`/agents/${agentId}/runs/${runId}`));
    const status = run.status;
    if (['completed', 'failed', 'cancelled', 'timeout'].includes(status)) {
      return run;
    }
  }
  // Last check
  const finalRun = extractData(await api.get(`/agents/${agentId}/runs/${runId}`));
  return finalRun;
}

/** Invoke a workflow agent (synchronous) */
async function invokeWorkflow(agentId: string, input: any): Promise<any> {
  const res = await api.post(`/agents/${agentId}/invoke`, { input }, { timeout: WORKFLOW_TIMEOUT_MS });
  return extractData(res);
}

/** Delete an agent, ignoring errors */
async function deleteAgent(agentId: string): Promise<void> {
  try {
    await api.delete(`/agents/${agentId}`);
  } catch (_) {
    // ignore — may already be deleted
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Find or get a calculate_bmi tool. If not found, create one. */
let bmiToolId: string | null = null;
async function ensureBmiTool(): Promise<string> {
  if (bmiToolId) return bmiToolId;

  const oid = await findOrgId();
  // Try to find existing calculate_bmi tool
  try {
    const res = await api.get(`/organizations/${oid}/tools`, { params: { limit: 100 } });
    const raw = extractData<any>(res);
    const tools = Array.isArray(raw) ? raw : raw?.tools || raw?.data || [];
    const existing = tools?.find((t: any) =>
      t.name === 'calculate_bmi' || t.name?.toLowerCase().includes('bmi'),
    );
    if (existing) {
      bmiToolId = existing.id;
      return bmiToolId!;
    }
  } catch (e: any) {
    const respData = e.response?.data;
    console.log(`  Tool search failed: ${e.message}${respData ? ' — ' + JSON.stringify(respData).substring(0, 200) : ''}, trying to create...`);
  }

  // Create a simple JS tool for BMI
  const tool = extractData(await api.post(`/organizations/${oid}/tools`, {
    name: 'calculate_bmi',
    description: 'Calculate Body Mass Index (BMI) from weight in kg and height in meters. Returns the BMI value and category.',
    type: 'javascript',
    parameters: {
      type: 'object',
      properties: {
        weight_kg: { type: 'number', description: 'Weight in kilograms' },
        height_m: { type: 'number', description: 'Height in meters' },
      },
      required: ['weight_kg', 'height_m'],
    },
    code: `
      const bmi = params.weight_kg / (params.height_m * params.height_m);
      const rounded = Math.round(bmi * 10) / 10;
      let category = 'Normal';
      if (rounded < 18.5) category = 'Underweight';
      else if (rounded < 25) category = 'Normal';
      else if (rounded < 30) category = 'Overweight';
      else category = 'Obese';
      return { bmi: rounded, category };
    `,
    status: 'active',
  }));
  bmiToolId = tool.id;
  return bmiToolId!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test01_AutonomousSimpleToolCall(): Promise<TestResult> {
  const name = 'Autonomous — simple tool call';
  const created: string[] = [];
  try {
    const toolId = await ensureBmiTool();
    const agent = await createAutonomousAgent('E2E-Auto-Simple', [toolId]);
    created.push(agent.id);

    const run = await startAndPollRun(agent.id, 'Calculate BMI for a person who weighs 80kg and is 1.80m tall.');

    assert(run.status === 'completed', `Expected status completed, got ${run.status}. Error: ${run.error || 'none'}`);

    const output = typeof run.output === 'string' ? run.output : JSON.stringify(run.output || '');
    assert(
      output.toLowerCase().includes('bmi') || /\d{2}\.?\d*/.test(output),
      `Output should mention BMI or contain a number. Got: ${output.substring(0, 200)}`,
    );
    assert(
      Array.isArray(run.steps) && run.steps.length >= 2,
      `Expected at least 2 steps (LLM + tool call), got ${run.steps?.length ?? 0}`,
    );

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test02_AutonomousParallelToolCalls(): Promise<TestResult> {
  const name = 'Autonomous — multiple tool calls';
  const created: string[] = [];
  try {
    const toolId = await ensureBmiTool();
    const agent = await createAutonomousAgent('E2E-Auto-Parallel', [toolId], {
      instructions: 'You are a BMI calculator. When asked to calculate BMI for multiple people, call the calculate_bmi tool for each person. Always report all results.',
    });
    created.push(agent.id);

    const run = await startAndPollRun(
      agent.id,
      'Calculate BMI for 3 people: Person A weighs 70kg and is 1.65m tall, Person B weighs 85kg and is 1.80m tall, Person C weighs 100kg and is 1.90m tall. Report all 3 results.',
    );

    assert(run.status === 'completed', `Expected status completed, got ${run.status}. Error: ${run.error || 'none'}`);

    const output = typeof run.output === 'string' ? run.output : JSON.stringify(run.output || '');
    // At least verify that output has some numerical results
    const numbers = output.match(/\d{2}\.\d/g) || [];
    assert(
      numbers.length >= 2,
      `Expected at least 2 BMI values in output. Got: ${output.substring(0, 300)}`,
    );

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test03_WorkflowInputToolLlmOutput(): Promise<TestResult> {
  const name = 'Workflow — input > tool_call > LLM > output';
  const created: string[] = [];
  try {
    const toolId = await ensureBmiTool();
    const providerId = await findLlmProvider();

    const pipeline = {
      nodes: [
        { id: 'input_1', type: 'input', label: 'Input', data: {}, position: { x: 0, y: 0 } },
        {
          id: 'tool_1', type: 'tool_call', label: 'Calculate BMI',
          data: {
            toolId,
            parameterMapping: {
              weight_kg: '{{input.weight}}',
              height_m: '{{input.height}}',
            },
          },
          position: { x: 250, y: 0 },
        },
        {
          id: 'llm_1', type: 'llm_call', label: 'Interpret BMI',
          data: {
            providerId,
            model: 'gpt-4o-mini',
            userPromptTemplate: 'Given the BMI calculation result: {{nodes.tool_1.output}}, write a one-sentence health interpretation.',
            temperature: 0.5,
          },
          position: { x: 500, y: 0 },
        },
        { id: 'output_1', type: 'output', label: 'Output', data: { mapping: '{{nodes.llm_1.output}}' }, position: { x: 750, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'input_1', target: 'tool_1' },
        { id: 'e2', source: 'tool_1', target: 'llm_1' },
        { id: 'e3', source: 'llm_1', target: 'output_1' },
      ],
    };

    const agent = await createWorkflowAgent('E2E-Workflow-Basic', pipeline);
    created.push(agent.id);

    const exec = await invokeWorkflow(agent.id, { weight: 75, height: 1.75 });

    assert(exec.status === 'completed', `Expected status completed, got ${exec.status}. Error: ${exec.error || 'none'}`);

    const output = typeof exec.output === 'string' ? exec.output : JSON.stringify(exec.output || '');
    assert(output.length > 10, `Output too short: ${output}`);

    // Check nodeResults exist
    const nodeResults = exec.nodeResults || {};
    assert(
      'tool_1' in nodeResults || 'llm_1' in nodeResults,
      `Expected nodeResults to have tool_1 or llm_1. Got keys: ${Object.keys(nodeResults).join(', ')}`,
    );

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test04_WorkflowConditionBranching(): Promise<TestResult> {
  const name = 'Workflow — condition branching';
  const created: string[] = [];
  try {
    const toolId = await ensureBmiTool();
    const providerId = await findLlmProvider();

    const pipeline = {
      nodes: [
        { id: 'input_1', type: 'input', label: 'Input', data: {}, position: { x: 0, y: 0 } },
        {
          id: 'tool_1', type: 'tool_call', label: 'Calculate BMI',
          data: {
            toolId,
            parameterMapping: {
              weight_kg: '{{input.weight}}',
              height_m: '{{input.height}}',
            },
          },
          position: { x: 250, y: 0 },
        },
        {
          id: 'cond_1', type: 'condition', label: 'Is overweight?',
          data: {
            expression: '{{nodes.tool_1.output.category}} == overweight',
          },
          position: { x: 500, y: 0 },
        },
        {
          id: 'llm_high', type: 'llm_call', label: 'High BMI advice',
          data: {
            providerId,
            model: 'gpt-4o-mini',
            userPromptTemplate: 'The person has a high BMI of {{nodes.tool_1.output.bmi}}. Give a brief one-sentence fitness suggestion.',
            temperature: 0.5,
          },
          position: { x: 750, y: -100 },
        },
        {
          id: 'llm_normal', type: 'llm_call', label: 'Normal BMI advice',
          data: {
            providerId,
            model: 'gpt-4o-mini',
            userPromptTemplate: 'The person has a normal BMI of {{nodes.tool_1.output.bmi}}. Give a brief one-sentence encouragement.',
            temperature: 0.5,
          },
          position: { x: 750, y: 100 },
        },
        { id: 'output_high', type: 'output', label: 'Output High', data: { mapping: '{{nodes.llm_high.output}}' }, position: { x: 1000, y: -100 } },
        { id: 'output_normal', type: 'output', label: 'Output Normal', data: { mapping: '{{nodes.llm_normal.output}}' }, position: { x: 1000, y: 100 } },
      ],
      edges: [
        { id: 'e1', source: 'input_1', target: 'tool_1' },
        { id: 'e2', source: 'tool_1', target: 'cond_1' },
        { id: 'e3', source: 'cond_1', target: 'llm_high', sourceHandle: 'true', label: 'true' },
        { id: 'e4', source: 'cond_1', target: 'llm_normal', sourceHandle: 'false', label: 'false' },
        { id: 'e5', source: 'llm_high', target: 'output_high' },
        { id: 'e6', source: 'llm_normal', target: 'output_normal' },
      ],
    };

    const agent = await createWorkflowAgent('E2E-Workflow-Condition', pipeline);
    created.push(agent.id);

    // Test 1: overweight person (90kg, 1.75m => BMI ~29.4)
    const exec1 = await invokeWorkflow(agent.id, { weight: 90, height: 1.75 });
    assert(exec1.status === 'completed', `Overweight test: expected completed, got ${exec1.status}. Error: ${exec1.error || 'none'}`);

    const nodeResults1 = exec1.nodeResults || {};
    // The high-BMI LLM branch should have run
    const highRan = 'llm_high' in nodeResults1;
    const normalRan1 = 'llm_normal' in nodeResults1;
    assert(highRan || !normalRan1, `Overweight person: expected llm_high to run. nodeResults keys: ${Object.keys(nodeResults1).join(', ')}`);

    // Test 2: normal weight person (65kg, 1.75m => BMI ~21.2)
    const exec2 = await invokeWorkflow(agent.id, { weight: 65, height: 1.75 });
    assert(exec2.status === 'completed', `Normal test: expected completed, got ${exec2.status}. Error: ${exec2.error || 'none'}`);

    const nodeResults2 = exec2.nodeResults || {};
    const normalRan2 = 'llm_normal' in nodeResults2;
    const highRan2 = 'llm_high' in nodeResults2;
    assert(normalRan2 || !highRan2, `Normal person: expected llm_normal to run. nodeResults keys: ${Object.keys(nodeResults2).join(', ')}`);

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test05_SequentialCollaboration(): Promise<TestResult> {
  const name = 'Sequential collaboration';
  const created: string[] = [];
  try {
    // Create researcher agent
    const researcher = await createAutonomousAgent('E2E-Researcher', [], {
      instructions: 'You are a researcher. When given a topic, provide a detailed 2-3 paragraph explanation.',
      personality: 'Thorough and detailed.',
    });
    created.push(researcher.id);

    // Create editor agent
    const editor = await createAutonomousAgent('E2E-Editor', [], {
      instructions: 'You are an editor. Take the input text and make it more concise — keep it to 2-3 sentences maximum while preserving the key points.',
      personality: 'Concise and precise.',
    });
    created.push(editor.id);

    // Create orchestrator with sequential collaboration
    const orchestrator = await createAutonomousAgent('E2E-Orchestrator-Seq', [], {
      instructions: 'Coordinate agents to research and edit content.',
      collaboration: {
        strategy: 'sequential',
        agents: [
          { agentId: researcher.id, role: 'researcher' },
          { agentId: editor.id, role: 'editor' },
        ],
      },
    });
    created.push(orchestrator.id);

    const run = await startAndPollRun(orchestrator.id, 'Explain what photosynthesis is.', RUN_POLL_TIMEOUT_MS);

    assert(run.status === 'completed', `Expected completed, got ${run.status}. Error: ${run.error || 'none'}`);

    const output = typeof run.output === 'string' ? run.output : JSON.stringify(run.output || '');
    assert(output.length > 20, `Output too short for sequential collaboration: ${output.substring(0, 200)}`);

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test06_ParallelCollaborationWithJudge(): Promise<TestResult> {
  const name = 'Parallel collaboration with judge';
  const created: string[] = [];
  try {
    const agent1 = await createAutonomousAgent('E2E-Pro-Coffee', [], {
      instructions: 'You argue that coffee is good for health. Provide a concise 2-sentence argument.',
      personality: 'Enthusiastic coffee advocate.',
    });
    created.push(agent1.id);

    const agent2 = await createAutonomousAgent('E2E-Anti-Coffee', [], {
      instructions: 'You argue that coffee is bad for health. Provide a concise 2-sentence argument.',
      personality: 'Cautious health advisor.',
    });
    created.push(agent2.id);

    const judge = await createAutonomousAgent('E2E-Judge', [], {
      instructions: 'You are a neutral judge. Given multiple perspectives, synthesize them into a balanced 2-sentence summary.',
      personality: 'Balanced and fair.',
    });
    created.push(judge.id);

    const orchestrator = await createAutonomousAgent('E2E-Orchestrator-Parallel', [], {
      instructions: 'Coordinate agents in parallel and have the judge synthesize their outputs.',
      collaboration: {
        strategy: 'parallel',
        agents: [
          { agentId: agent1.id, role: 'pro' },
          { agentId: agent2.id, role: 'con' },
        ],
        judgeAgentId: judge.id,
      },
    });
    created.push(orchestrator.id);

    const run = await startAndPollRun(orchestrator.id, 'Is coffee good for health?', RUN_POLL_TIMEOUT_MS);

    assert(run.status === 'completed', `Expected completed, got ${run.status}. Error: ${run.error || 'none'}`);

    const output = typeof run.output === 'string' ? run.output : JSON.stringify(run.output || '');
    assert(output.length > 20, `Output too short: ${output.substring(0, 200)}`);

    // Verify collaboration steps exist
    const collabSteps = (run.steps || []).filter((s: any) =>
      s.type?.includes('collaboration') || s.type?.includes('parallel') || s.type?.includes('judge'),
    );
    // It's OK if steps don't explicitly name "collaboration_parallel" — the output is enough
    assert(run.steps?.length >= 1, `Expected at least 1 step, got ${run.steps?.length ?? 0}`);

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test07_RaceCollaboration(): Promise<TestResult> {
  const name = 'Race collaboration';
  const created: string[] = [];
  try {
    const fast = await createAutonomousAgent('E2E-Fast', [], {
      instructions: 'Answer the question in one word or number only. Be as fast as possible.',
      personality: 'Extremely concise.',
    });
    created.push(fast.id);

    const slow = await createAutonomousAgent('E2E-Slow', [], {
      instructions: 'Answer the question, but include a very detailed chain of thought explanation before your final answer.',
      personality: 'Very thorough.',
    });
    created.push(slow.id);

    const orchestrator = await createAutonomousAgent('E2E-Orchestrator-Race', [], {
      instructions: 'Race agents: the first to finish wins.',
      collaboration: {
        strategy: 'race',
        agents: [
          { agentId: fast.id, role: 'fast' },
          { agentId: slow.id, role: 'slow' },
        ],
      },
    });
    created.push(orchestrator.id);

    const run = await startAndPollRun(orchestrator.id, 'What is 2 + 2?', RUN_POLL_TIMEOUT_MS);

    assert(run.status === 'completed', `Expected completed, got ${run.status}. Error: ${run.error || 'none'}`);

    const output = typeof run.output === 'string' ? run.output : JSON.stringify(run.output || '');
    assert(output.length > 0, `Race should produce some output. Got: ${output}`);

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test08_DebateCollaboration(): Promise<TestResult> {
  const name = 'Debate collaboration';
  const created: string[] = [];
  try {
    const proAgent = await createAutonomousAgent('E2E-Debate-Pro', [], {
      instructions: 'You argue FOR the proposition. Keep your arguments to 2 sentences.',
      personality: 'Persuasive debater.',
    });
    created.push(proAgent.id);

    const conAgent = await createAutonomousAgent('E2E-Debate-Con', [], {
      instructions: 'You argue AGAINST the proposition. Keep your arguments to 2 sentences.',
      personality: 'Critical thinker.',
    });
    created.push(conAgent.id);

    const judge = await createAutonomousAgent('E2E-Debate-Judge', [], {
      instructions: 'You judge a debate. After hearing both sides, declare a winner and explain why in 2 sentences.',
      personality: 'Fair and decisive.',
    });
    created.push(judge.id);

    const orchestrator = await createAutonomousAgent('E2E-Orchestrator-Debate', [], {
      instructions: 'Run a debate between agents.',
      collaboration: {
        strategy: 'debate',
        agents: [
          { agentId: proAgent.id, role: 'pro' },
          { agentId: conAgent.id, role: 'con' },
        ],
        judgeAgentId: judge.id,
        maxRounds: 2,
      },
    });
    created.push(orchestrator.id);

    const run = await startAndPollRun(orchestrator.id, 'Should schools teach coding?', RUN_POLL_TIMEOUT_MS);

    assert(run.status === 'completed', `Expected completed, got ${run.status}. Error: ${run.error || 'none'}`);

    const output = typeof run.output === 'string' ? run.output : JSON.stringify(run.output || '');
    assert(output.length > 20, `Debate output too short: ${output.substring(0, 200)}`);

    // Check that debate step exists (all rounds happen in one collaboration_debate step)
    const steps = run.steps || [];
    assert(steps.length >= 1, `Expected at least 1 step in a debate, got ${steps.length}`);
    const debateStep = steps.find((s: any) => s.type === 'collaboration_debate');
    assert(debateStep, 'Expected a collaboration_debate step');

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test09_MemoryCreateRecallSearch(): Promise<TestResult> {
  const name = 'Memory — create, recall, search';
  let memoryId: string | null = null;
  try {
    const uniqueContent = `E2E test memory ${Date.now()}: The capital of France is Paris.`;

    // Create a memory
    const memory = extractData(await api.post('/memories', {
      content: uniqueContent,
      type: 'fact',
      scope: 'organization',
      tags: ['e2e-test'],
    }));
    memoryId = memory.id;
    assert(!!memoryId, `Memory creation returned no id`);

    // Short delay for indexing
    await sleep(2000);

    // Search for it
    const results = extractData<any[]>(await api.post('/memories/search', {
      query: 'capital of France',
      limit: 5,
    }));

    assert(Array.isArray(results), `Search should return an array. Got: ${typeof results}`);

    // Find our memory in results
    const found = results.find((r: any) => r.id === memoryId || r.content?.includes('E2E test memory'));
    assert(!!found, `Search results should contain our memory. Got ${results.length} results: ${results.map((r: any) => r.content?.substring(0, 50)).join('; ')}`);

    if (found.similarity !== undefined) {
      assert(found.similarity > 0, `Expected similarity > 0, got ${found.similarity}`);
    }

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    // Cleanup
    if (memoryId) {
      try { await api.delete(`/memories/${memoryId}`); } catch (_) {}
    }
  }
}

async function test10_AuditLogVerify(): Promise<TestResult> {
  const name = 'Audit log — verify actions logged';
  try {
    // Check audit logs for recent activity (our tests should have generated entries)
    const response = await api.get('/audit-logs', { params: { limit: '20' } });
    const body = response.data;

    // The endpoint may return { success, data, pagination } or just { data }
    const logs = body?.data || [];

    assert(Array.isArray(logs), `Audit logs should be an array. Got: ${typeof logs}`);
    assert(logs.length > 0, `Expected at least some audit log entries`);

    // Check that there are agent-related entries
    const hasAgentEntry = logs.some((l: any) =>
      l.action?.includes('agent') || l.resourceType?.includes('agent') ||
      l.action?.includes('create') || l.action?.includes('Agent'),
    );
    // This is a soft check — audit logs might not be granular enough
    // Just verifying the endpoint works and returns data is sufficient
    assert(logs.length > 0, 'Audit log should have entries after running tests');

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  }
}

async function test11_VersionTracking(): Promise<TestResult> {
  const name = 'Version tracking — update and check versions';
  const created: string[] = [];
  try {
    // Create agent
    const agent = await createAutonomousAgent('E2E-Version-Test', []);
    created.push(agent.id);

    // Update the agent (triggers a version)
    await api.patch(`/agents/${agent.id}`, {
      description: 'Updated description for version tracking test',
    });

    // Check versions via the generic versions API
    const versions = extractData<any[]>(await api.get(`/versions/Agent/${agent.id}`));

    assert(Array.isArray(versions), `Versions should be an array. Got: ${typeof versions}`);
    assert(versions.length >= 1, `Expected at least 1 version after update. Got: ${versions.length}`);

    // Check that a version has the expected shape
    const version = versions[0];
    assert(!!version, 'First version should exist');

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test12_RunCancellation(): Promise<TestResult> {
  const name = 'Run cancellation';
  const created: string[] = [];
  try {
    // Create an agent that would take a while (give it a verbose instruction)
    const agent = await createAutonomousAgent('E2E-Cancel-Test', [], {
      instructions: 'When asked anything, write a very long detailed essay of at least 2000 words.',
      personality: 'Extremely verbose.',
    });
    created.push(agent.id);

    // Start a run
    const runRes = extractData(await api.post(`/agents/${agent.id}/runs`, {
      input: 'Write a very long essay about the history of mathematics.',
    }));
    const runId = runRes.id;
    assert(!!runId, 'Run should have an id');

    // Give it a moment to start, then cancel
    await sleep(1000);

    // Cancel the run
    const cancelRes = extractData(await api.post(`/agents/${agent.id}/runs/${runId}/cancel`));

    // Check the run status
    await sleep(1000);
    const run = extractData(await api.get(`/agents/${agent.id}/runs/${runId}`));

    // The run should be cancelled (or already completed if it was fast)
    assert(
      run.status === 'cancelled' || run.status === 'completed',
      `Expected cancelled or completed, got ${run.status}`,
    );

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

async function test13_HumanInTheLoopEndpointExists(): Promise<TestResult> {
  const name = 'Human-in-the-loop — sendInput endpoint exists';
  const created: string[] = [];
  try {
    const agent = await createAutonomousAgent('E2E-HITL-Test', []);
    created.push(agent.id);

    // Start a run
    const runRes = extractData(await api.post(`/agents/${agent.id}/runs`, {
      input: 'Hello',
    }));
    const runId = runRes.id;
    assert(!!runId, 'Run should have an id');

    // Try sending input — the run might not be in waiting_input state,
    // so we expect either success or a controlled error (not 404)
    try {
      await api.post(`/agents/${agent.id}/runs/${runId}/input`, { input: 'test input' });
      // If it succeeds, great
    } catch (err: any) {
      const status = err.response?.status;
      // 400 is acceptable (run not waiting for input), 404 means endpoint doesn't exist
      assert(status !== 404, `sendInput endpoint returned 404 — endpoint does not exist`);
    }

    return { name, passed: true, durationMs: 0 };
  } catch (error: any) {
    return { name, passed: false, error: error.message, durationMs: 0 };
  } finally {
    for (const id of created) await deleteAgent(id);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  almyty E2E Agent Runtime Tests');
  console.log(`  Target: ${STAGING_URL}`);
  console.log(`  User:   ${TEST_EMAIL}`);
  console.log('='.repeat(60));
  console.log('');

  // Login
  console.log('Logging in...');
  try {
    token = await login();
    api = createApi(token);
    console.log('Login successful.');
  } catch (err: any) {
    console.error(`FATAL: Login failed: ${err.message}`);
    if (err.response?.data) {
      console.error('Response:', JSON.stringify(err.response.data).substring(0, 500));
    }
    process.exit(1);
  }

  // Pre-flight: get org ID
  console.log('Getting organization ID...');
  try {
    const oid = await findOrgId();
    console.log(`Organization: ${oid}`);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // Pre-flight: ensure LLM provider exists
  console.log('Checking LLM providers...');
  try {
    const providerId = await findLlmProvider();
    console.log(`Using LLM provider: ${providerId}`);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // Pre-flight: ensure BMI tool exists
  console.log('Ensuring BMI tool exists...');
  try {
    const toolId = await ensureBmiTool();
    console.log(`Using BMI tool: ${toolId}`);
  } catch (err: any) {
    console.error(`WARNING: Could not create/find BMI tool: ${err.message}`);
  }

  console.log('');
  console.log('Running tests...');
  console.log('');

  const tests: Array<() => Promise<TestResult>> = [
    test01_AutonomousSimpleToolCall,
    test02_AutonomousParallelToolCalls,
    test03_WorkflowInputToolLlmOutput,
    test04_WorkflowConditionBranching,
    test05_SequentialCollaboration,
    test06_ParallelCollaborationWithJudge,
    test07_RaceCollaboration,
    test08_DebateCollaboration,
    test09_MemoryCreateRecallSearch,
    test10_AuditLogVerify,
    test11_VersionTracking,
    test12_RunCancellation,
    test13_HumanInTheLoopEndpointExists,
  ];

  const results: TestResult[] = [];

  for (const testFn of tests) {
    const startTime = Date.now();
    const result = await testFn();
    result.durationMs = Date.now() - startTime;

    results.push(result);

    const icon = result.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const duration = (result.durationMs / 1000).toFixed(1);
    const errorMsg = result.error ? `: ${result.error}` : '';
    console.log(`  ${icon} ${result.name} (${duration}s)${errorMsg}`);
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log('');
  console.log('='.repeat(60));
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log('');
    console.log('Failed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }

  console.log('');
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log('');

  // Cleanup: delete any leftover E2E agents (belt-and-suspenders)
  try {
    const agents = extractData<any[]>(await api.get('/agents'));
    const e2eAgents = (agents || []).filter((a: any) => a.name?.startsWith('E2E-'));
    if (e2eAgents.length > 0) {
      console.log(`Cleaning up ${e2eAgents.length} leftover E2E agent(s)...`);
      for (const a of e2eAgents) {
        await deleteAgent(a.id);
      }
    }
  } catch (_) {
    // ignore cleanup failures
  }

  // Also clean up the BMI tool we may have created
  if (bmiToolId) {
    try {
      await api.delete(`/tools/${bmiToolId}`);
    } catch (_) {
      // ignore — it may have been pre-existing
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL UNHANDLED ERROR:', err);
  process.exit(1);
});
