import { AgentChannelsController } from '../../agent-channels/agent-channels.controller';
import { holdsVisitorData } from '../../agent-channels/visitor-data-requests.service';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { a2aCallerCandidates, emptyFootprint, mergeFootprints } from '../visitor-data.service';
import { subjectRef, visitorDataAudit } from '../visitor-data-audit';
import { AuditAction } from '../../../entities/audit-log.entity';
import { inboundMessageRecord } from '../channels/channel-gateway.service';

/**
 * The small rules a data request stands on: how a person is referred to in
 * the audit log, how an A2A caller is matched, how one person's footprints
 * on several channels become one, and who may ask at all. The behaviour
 * against Postgres is in test/integration/visitor-data.integration.spec.ts.
 */
describe('visitor data rules', () => {
  it('refers to a person by a hash that is stable per organization and never the identifier', () => {
    const ref = subjectRef('org-1', ' Dana@Example.com ');
    expect(ref).toMatch(/^sha256:[0-9a-f]{24}$/);
    expect(subjectRef('org-1', 'dana@example.com')).toBe(ref);
    expect(subjectRef('org-2', 'dana@example.com')).not.toBe(ref);
    expect(ref).not.toContain('dana');
  });

  it('writes an audit row with counts and the hash only', () => {
    const entry = visitorDataAudit({
      action: AuditAction.VISITOR_DATA_ERASE,
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentName: 'Front desk',
      userId: 'user-1',
      channel: 'all',
      identifier: '+14155550100',
      counts: { messages: 4 },
    });
    expect(entry).toMatchObject({ resourceType: 'agent', resourceId: 'agent-1', userId: 'user-1' });
    expect(entry.details).toEqual({ request: 'erase', by: 'owner', channel: 'all', subject: subjectRef('org-1', '+14155550100'), counts: { messages: 4 } });
    expect(JSON.stringify(entry)).not.toContain('4155550100');
  });

  it('matches an A2A caller by the bare id under every kind of credential, or by the stamped form alone', () => {
    expect(a2aCallerCandidates('abc')).toEqual(['key:abc', 'oauth:abc', 'jwt:abc', 'user:abc']);
    expect(a2aCallerCandidates('oauth:client-9')).toEqual(['oauth:client-9']);
    expect(a2aCallerCandidates('  ')).toEqual([]);
  });

  it("merges one person's footprints on several channels, each id once, and drops another organization's", () => {
    const web = { ...emptyFootprint('org-1', ['gw-web']), endUserIds: ['eu-1'], runIds: ['r1', 'r2'], conversationIds: ['c1'], unansweredEventIds: ['ev-1'] };
    const widget = { ...emptyFootprint('org-1', ['gw-widget']), runIds: ['r2', 'r3'], widgetThreads: [{ gatewayId: 'gw-widget', threadId: 't' }] };
    const elsewhere = { ...emptyFootprint('org-2', ['gw-x']), runIds: ['r9'], conversationIds: ['c9'] };
    expect(mergeFootprints('org-1', [web, widget, widget, elsewhere])).toEqual({
      organizationId: 'org-1',
      gatewayIds: ['gw-web', 'gw-widget'],
      endUserIds: ['eu-1'],
      runIds: ['r1', 'r2', 'r3'],
      conversationIds: ['c1'],
      widgetThreads: [{ gatewayId: 'gw-widget', threadId: 't' }],
      unansweredEventIds: ['ev-1'],
    });
  });

  it('keeps of an inbound message its words and file names, bounded, and nothing else', () => {
    const record = inboundMessageRecord({
      text: 'Where is my order?',
      attachments: [{ name: 'receipt.pdf', type: 'application/pdf', url: 'https://files.example/r.pdf', data: Buffer.from('x') }],
      ...({ metadata: { team_id: 'T0', bot_id: 'B0' }, userId: 'U1' } as any),
    });
    expect(record).toEqual({ text: 'Where is my order?', attachments: ['receipt.pdf'] });
    expect(inboundMessageRecord({ text: 'hi' })).toEqual({ text: 'hi' });
    expect(inboundMessageRecord({ text: '' })).toBeNull();
    expect(inboundMessageRecord({ text: 'x'.repeat(30_000) })!.text).toHaveLength(20_000);
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain' }));
    expect(inboundMessageRecord({ text: '', attachments: many })!.attachments).toHaveLength(20);
  });
  it('looks people up only on channels people talk to', () => {
    expect(['web', 'widget', 'a2a', 'telegram', 'sms', 'email', 'slack'].every(holdsVisitorData)).toBe(true);
    expect(holdsVisitorData('desktop')).toBe(false);
    expect(holdsVisitorData('tui')).toBe(false);
  });

  it.each(['lookupVisitorData', 'exportVisitorData', 'eraseVisitorData'])(
    '%s lets a member through the role guard, for the service to decide whether they manage the agent',
    (method) => {
      const handler = (AgentChannelsController.prototype as any)[method];
      // Viewers never; members only for an agent they own (visitor-data.integration.spec.ts).
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['member', 'admin', 'owner']);
    },
  );
});
