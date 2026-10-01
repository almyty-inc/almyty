/**
 * The broker of code mode (docs/design/code-mode.md, part C, "The
 * broker"): the host side of every call a script makes. The sandbox has no
 * network and no credentials; each namespace function in it is a stub that
 * posts here, and this decides, call by call:
 *
 *   1. resolve the name only within the scope the script was given (the
 *      agent's executable tools); anything else is "not found";
 *   2. claim a slot on the script's budget (total and in flight; refused,
 *      never queued);
 *   3. apply the write policy (code-write-policy.ts): run, stage into the
 *      change set, or refuse;
 *   4. run it through `execute`, which is ToolExecutorService.executeTool
 *      with the outer call's principal and scope: access, servability,
 *      security policy, schema validation, plugins, amount rules, cache,
 *      rate limits, credentials and egress all happen there, unchanged;
 *      an amount rule's hold becomes a staged entry with the rule shown;
 *   5. hand the script the data, or make its stub throw.
 */
import { Tool } from '../../entities/tool.entity';
import type { ChangeSetEntry } from '../../entities/code-execution.entity';
import { CodeCall, CodeCallError } from '../tools/node-sandbox/types';
import type { ToolExecutionResult } from '../tools/tool-execution.types';
import { paramsHash } from '../tools/tool-approval-gate.service';
import { NamedTool, readableToolName } from '../tools/tool-readable-name';
import { ToolDiscoveryService } from '../tool-discovery/tool-discovery.service';
import { CodeName, codeNames } from '../tool-discovery/tool-signature';
import { CodeModeConfig, decideCall } from './code-write-policy';
import type { CodeModeLimits } from './code-mode.settings';

/** extract(value, schema): a model call that returns an object matching the schema, or throws. */
export type ExtractFn = (value: unknown, schema: Record<string, any>) => Promise<{ value: unknown; cost: number; tokens: number }>;

/** One call a script made, for the trace and the model's summary. */
export interface BrokeredCall {
  op: CodeCall['op'];
  /** The code name (`petstore.updatePet`), or the query for a search. */
  target: string;
  toolId?: string;
  outcome: 'ran' | 'failed' | 'staged' | 'refused';
  error?: string;
  ms: number;
}

export interface BrokerDeps {
  /** The tools the script may use, with their API names attached (the namespaces). */
  scope: Tool[];
  organizationId: string;
  policy: CodeModeConfig | null | undefined;
  /** Grants left in this run (tool id -> calls); decremented as they are used. */
  grantsLeft: Map<string, number>;
  limits: Pick<CodeModeLimits, 'maxCalls' | 'maxInFlight'>;
  discovery: ToolDiscoveryService;
  execute: (tool: Tool, args: Record<string, any>) => Promise<ToolExecutionResult>;
  extract?: ExtractFn;
}

export class CodeBroker {
  readonly names: Map<string, CodeName>;
  private readonly byCodeName = new Map<string, Tool>();
  readonly changeSet: ChangeSetEntry[] = [];
  readonly calls: BrokeredCall[] = [];
  /** Tool id -> calls a grant let through in this script. */
  readonly grantsUsed: Record<string, number> = {};
  extractCost = 0;
  extractTokens = 0;
  private used = 0;
  private inFlight = 0;

  constructor(private readonly deps: BrokerDeps) {
    this.names = codeNames(deps.scope);
    for (const tool of deps.scope) {
      const name = this.names.get(tool.id)!;
      this.byCodeName.set(`${name.namespace}.${name.fn}`, tool);
    }
  }

  /** What the script sees: namespace -> function names. */
  namespaces(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const { namespace, fn } of this.names.values()) (out[namespace] ??= []).push(fn);
    for (const fns of Object.values(out)) fns.sort();
    return out;
  }

  codeNameOf(tool: Tool): string {
    const name = this.names.get(tool.id)!;
    return `${name.namespace}.${name.fn}`;
  }

  /** The scope's tool a script names: by code name (`petstore.getPetById`) or by tool name. */
  resolve(name: string): Tool | null {
    return this.byCodeName.get(name) ?? this.deps.scope.find((t) => t.name === name) ?? null;
  }

  async handle(call: CodeCall): Promise<unknown> {
    const started = Date.now();
    const target = call.op === 'tool' ? `${call.namespace}.${call.fn}` : call.op === 'search' ? String(call.query ?? '') : call.op === 'extract' ? 'extract' : String((call as any).name ?? '');
    const release = this.claim(target);
    try {
      return await this.dispatch(call, target, started);
    } finally {
      release();
    }
  }

  private claim(target: string): () => void {
    if (this.used >= this.deps.limits.maxCalls) {
      throw new CodeCallError(`This script has made its ${this.deps.limits.maxCalls} calls; split the work into another script.`, target);
    }
    if (this.inFlight >= this.deps.limits.maxInFlight) {
      throw new CodeCallError(`At most ${this.deps.limits.maxInFlight} calls may run at once; await some before starting more.`, target);
    }
    this.used++;
    this.inFlight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };
  }

  private async dispatch(call: CodeCall, target: string, started: number): Promise<unknown> {
    switch (call.op) {
      case 'search': {
        const query = typeof call.query === 'string' ? call.query.trim() : '';
        if (!query) throw new CodeCallError('tools.search needs a query');
        const limit = Number.isInteger(call.limit) && (call.limit as number) > 0 ? (call.limit as number) : undefined;
        const { results } = await this.deps.discovery.search(this.deps.scope, query, {
          organizationId: this.deps.organizationId,
          limit,
          nameOf: (t) => this.codeNameOf(t),
        });
        this.calls.push({ op: 'search', target: query, outcome: 'ran', ms: Date.now() - started });
        return results;
      }
      case 'get': {
        const tool = typeof call.name === 'string' ? this.resolve(call.name) : null;
        if (!tool) throw new CodeCallError(`No tool named "${String(call.name)}" here. Use tools.search to find one.`, String(call.name));
        const detail = call.detail === 'name' || call.detail === 'description' ? call.detail : 'full';
        this.calls.push({ op: 'get', target: this.codeNameOf(tool), toolId: tool.id, outcome: 'ran', ms: Date.now() - started });
        return this.deps.discovery.describe(this.deps.scope, tool, detail, (t) => this.codeNameOf(t));
      }
      case 'extract': {
        if (!this.deps.extract) throw new CodeCallError('extract() is not available here.', 'extract');
        const schema = call.schema;
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new CodeCallError('extract() needs a JSON Schema object as its second argument.', 'extract');
        try {
          const out = await this.deps.extract(call.value, schema as Record<string, any>);
          this.extractCost += out.cost;
          this.extractTokens += out.tokens;
          this.calls.push({ op: 'extract', target, outcome: 'ran', ms: Date.now() - started });
          return out.value;
        } catch (err: any) {
          this.calls.push({ op: 'extract', target, outcome: 'failed', error: err?.message, ms: Date.now() - started });
          throw new CodeCallError(`extract() failed: ${err?.message ?? err}`, 'extract');
        }
      }
      case 'call':
      case 'tool': {
        const tool = call.op === 'tool' ? (this.byCodeName.get(target) ?? null) : typeof call.name === 'string' ? this.resolve(call.name) : null;
        if (!tool) throw new CodeCallError(`No tool named "${target}" here. Use tools.search to find one.`, target);
        const args = call.args ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) throw new CodeCallError('A tool takes one object of arguments.', this.codeNameOf(tool));
        return this.runTool(tool, args as Record<string, any>, started);
      }
      default:
        throw new CodeCallError('Unknown call');
    }
  }

  private async runTool(tool: Tool, args: Record<string, any>, started: number): Promise<unknown> {
    const codeName = this.codeNameOf(tool);
    const decision = decideCall(tool.sideEffect, tool.id, this.deps.policy, this.deps.grantsLeft);
    if (decision.action === 'deny') {
      this.calls.push({ op: 'tool', target: codeName, toolId: tool.id, outcome: 'refused', ms: Date.now() - started });
      throw new CodeCallError(
        `${codeName} ${tool.sideEffect === 'destructive' ? 'deletes' : 'changes'} data and is not allowed in scripts here. Ask the person, or do without it.`,
        codeName,
      );
    }
    if (decision.action === 'stage') return this.stage(tool, args, 'policy', undefined, started);
    if (decision.viaGrant) this.grantsUsed[tool.id] = (this.grantsUsed[tool.id] ?? 0) + 1;

    const result = await this.deps.execute(tool, args);
    // An amount rule held it: the same change set, with the rule shown, and
    // the fingerprint the rule computed (on the parameters the tool would
    // receive), so approving the set covers this call.
    if (result.approvalRequired) {
      return this.stage(tool, args, 'amount_rule', result.approvalRequired.summary, started, result.approvalRequired.paramsHash);
    }
    if (!result.success) {
      this.calls.push({ op: 'tool', target: codeName, toolId: tool.id, outcome: 'failed', error: result.error, ms: Date.now() - started });
      throw new CodeCallError(result.error || `${codeName} failed`, codeName);
    }
    this.calls.push({ op: 'tool', target: codeName, toolId: tool.id, outcome: 'ran', ms: Date.now() - started });
    return result.data ?? null;
  }

  /** Put a call in the change set. The script gets a receipt, not data: the call has not run. */
  private stage(tool: Tool, args: Record<string, any>, reason: ChangeSetEntry['reason'], rule: string | undefined, started: number, fingerprint?: string) {
    const codeName = this.codeNameOf(tool);
    const entry: ChangeSetEntry = {
      id: this.changeSet.length + 1,
      toolId: tool.id,
      toolName: tool.name,
      codeName,
      title: readableToolName(tool as NamedTool),
      arguments: args,
      paramsHash: fingerprint ?? paramsHash(args),
      sideEffect: tool.sideEffect ?? 'write',
      reason,
      ...(rule ? { rule } : {}),
    };
    this.changeSet.push(entry);
    this.calls.push({ op: 'tool', target: codeName, toolId: tool.id, outcome: 'staged', ms: Date.now() - started });
    return {
      staged: true,
      id: entry.id,
      tool: codeName,
      note: 'Staged for approval. It has not run, so there is no result yet.',
    };
  }
}
