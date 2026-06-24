import { Injectable } from '@nestjs/common';

import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';

/**
 * Pure rendering for promoted skills: slug/escape helpers, a deterministic
 * procedure distilled from a run's steps (no LLM), and the SKILL.md assembler
 * following the Agent Skills open standard (agentskills.io/specification).
 */
@Injectable()
export class PromotedSkillRenderer {
  slugify(text: string): string {
    return (text || 'skill')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill';
  }

  private escapeYaml(text: string): string {
    const t = (text || '').replace(/\n+/g, ' ').trim();
    return /[:#\[\]{}]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
  }

  /**
   * Deterministic distillation (no LLM): assemble a procedure from the task,
   * the sequence of tool calls the run actually made, and the final answer.
   */
  deterministicProcedure(run: AgentRun, agent?: Agent): string {
    const lines: string[] = [];
    if (agent?.instructions) {
      lines.push(`Approach: ${agent.instructions.trim()}`, '');
    }
    const toolSteps = (run.steps || []).filter(
      (s) => s.type === 'tool_call' || s.type === 'sub_agent_call',
    );
    if (toolSteps.length > 0) {
      lines.push('Steps that produced a successful result:', '');
      toolSteps.forEach((s, i) => {
        const tool = s.input?.tool || s.input?.agentId || 'action';
        lines.push(`${i + 1}. Use \`${tool}\`${s.error ? ' (recovered after an error)' : ''}.`);
      });
      lines.push('');
    } else {
      lines.push('This run reached its answer through reasoning alone (no tool calls).', '');
    }
    return lines.join('\n').trim();
  }

  /** Assemble the full SKILL.md from a distilled procedure + run/agent context. */
  renderSkillMd(opts: {
    slug: string;
    description: string;
    procedure: string;
    run: AgentRun;
    agent?: Agent;
    version: number;
  }): string {
    const { slug, description, procedure, run, agent, version } = opts;
    const lines: string[] = [];

    lines.push('---');
    lines.push(`name: ${slug}`);
    lines.push(`description: ${this.escapeYaml(description)}`);
    lines.push('metadata:');
    lines.push('  author: almyty');
    lines.push('  generated: "true"');
    lines.push('  source: agent-run');
    if (run.id) lines.push(`  runId: "${run.id}"`);
    if (agent?.id) lines.push(`  agentId: "${agent.id}"`);
    lines.push(`  version: "${version}"`);
    lines.push('---');
    lines.push('');

    lines.push(`# ${agent?.name || slug}`);
    lines.push('');
    if (description) {
      lines.push(description);
      lines.push('');
    }

    lines.push('## When to use');
    lines.push('');
    lines.push(
      `Use this skill for tasks like the one this run solved successfully${
        agent?.description ? `: ${agent.description}` : '.'
      }`,
    );
    lines.push('');

    const taskText =
      typeof run.input === 'string' ? run.input : run.input ? JSON.stringify(run.input) : '';
    if (taskText) {
      lines.push('## Example task');
      lines.push('');
      lines.push('```');
      lines.push(taskText.slice(0, 1000));
      lines.push('```');
      lines.push('');
    }

    lines.push('## Procedure');
    lines.push('');
    lines.push(procedure || 'Follow the agent instructions to reproduce the result.');
    lines.push('');

    const output =
      typeof run.output === 'string' ? run.output : run.output ? JSON.stringify(run.output, null, 2) : '';
    if (output) {
      lines.push('## Reference result');
      lines.push('');
      lines.push('```');
      lines.push(output.slice(0, 2000));
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  }
}
