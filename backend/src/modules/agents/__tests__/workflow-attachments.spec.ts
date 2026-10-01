import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { buildHarness, edge, llm, makeAgent, node } from './workflow-harness';
import { inputAttachments } from '../attached-files';

/**
 * Files a workflow run is invoked with (`input.attachments`, uploaded to
 * /files first) go to every llm_call whose prompt reads the input, after
 * its text, as references the model call resolves. Through the real engine,
 * node executor and template resolver; only the model is faked.
 */
describe('workflow llm_call: files the run was invoked with', () => {
  const pipeline = () => ({
    nodes: [
      node('in', 'input'),
      llm('look', 'Describe: {{input.question}}'),
      llm('polish', 'Tidy this up: {{nodes.look.output}}'),
      node('out', 'output', { source: 'nodes.polish.output' }),
    ],
    edges: [edge('in', 'look'), edge('look', 'polish'), edge('polish', 'out')],
  });

  it('a node whose prompt reads the input gets the files; one that does not, does not', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline() as any), {
      question: 'what is on this label?',
      attachments: [{ fileId: 'f-label', name: 'label.png', mimeType: 'image/png' }, 'f-invoice'],
    });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    const [look, polish] = h.chat.mock.calls.map(([, req]) => req.messages[req.messages.length - 1].content);
    expect(look).toEqual([
      { type: 'text', text: 'Describe: what is on this label?' },
      { type: 'file', fileId: 'f-label', name: 'label.png', mimeType: 'image/png' },
      { type: 'file', fileId: 'f-invoice', name: 'attachment', mimeType: 'application/octet-stream' },
    ]);
    expect(typeof polish).toBe('string');
  });

  it('a run without files sends plain prompts', async () => {
    const h = buildHarness();
    await h.run(makeAgent(pipeline() as any), { question: 'hi' });
    const messages = h.chat.mock.calls[0][1].messages;
    expect(messages[messages.length - 1].content).toBe('Describe: hi');
  });

  it('reads at most five, and only well-formed references', () => {
    expect(inputAttachments({ attachments: [42, null, { name: 'no id' }, 'a', 'b', 'c', 'd', 'e', 'f'] }).map((p) => p.fileId)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(inputAttachments({ attachments: 'f1' })).toEqual([]);
    expect(inputAttachments(null)).toEqual([]);
  });
});
