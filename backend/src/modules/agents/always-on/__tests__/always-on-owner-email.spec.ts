import { describeWebhook, wakeMessage } from '../always-on.service';
import { mergeAlwaysOn } from '../always-on.types';
import { AGENT, ORG, alwaysOnAgent, world } from './always-on.harness';

const MAIL = 'abababab-abab-4bab-8bab-abababababab';
const GW_MAIL = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

/**
 * Frane: email from the owner's address may count as the owner, but only
 * as an option, off by default, because an email sender can be faked.
 */
describe('Always on: the owner on email', () => {
  const mailWorld = (trustEmail?: boolean) => {
    const w = world({
      agent: alwaysOnAgent({}, {
        wakeOn: { timer: null, channelIds: [] },
        ownerChannel: { channelId: MAIL, address: 'owner@example.test', ...(trustEmail === undefined ? {} : { trustEmail }) },
      }),
    });
    w.channels.seed({ id: MAIL, organizationId: ORG, agentId: AGENT, type: 'email', name: 'Inbox', gatewayId: GW_MAIL });
    return w;
  };
  const mail = { organizationId: ORG, agentId: AGENT, gatewayId: GW_MAIL, text: 'Refund NW-1 please', deliveryId: 'm1', senderId: 'Olivia <Owner@Example.test>' };

  it('off (the default): their email is a note like anyone else\'s, and they keep an ordinary chat', async () => {
    const w = mailWorld();
    expect(await w.service.routeInbound(mail)).toBe('continue');
    const [wake] = w.wakes.rows();
    expect(wake.summary).toContain('wrote on Inbox (they have their own chat');
    expect(wake.payload).toBeNull();
    expect(JSON.stringify(wake)).not.toContain('Refund NW-1');
  });

  it('on: their email joins the standing thread and the answer goes back to them', async () => {
    const w = mailWorld(true);
    expect(await w.service.routeInbound(mail)).toBe('consumed');
    const [wake] = w.wakes.rows();
    expect(wake.payload.ownerMessage).toMatchObject({ text: 'Refund NW-1 please', replyTo: { channelId: MAIL, to: 'owner@example.test' } });
  });

  it('is stored only when set, and only as true or false', () => {
    const owner = { channelId: MAIL, address: 'owner@example.test' };
    expect(mergeAlwaysOn(null, { ownerChannel: owner }).ownerChannel!.trustEmail).toBe(false);
    expect(mergeAlwaysOn(null, { ownerChannel: { ...owner, trustEmail: true } }).ownerChannel!.trustEmail).toBe(true);
    expect(mergeAlwaysOn(null, { ownerChannel: { ...owner, trustEmail: 'yes' as any } }).ownerChannel!.trustEmail).toBe(false);
  });
});

describe('Always on: a webhook in plain words', () => {
  it('reads the usual fields instead of showing JSON', () => {
    expect(describeWebhook('GitHub', '{"action":"comment","body":"Customer replied while waiting"}')).toBe(
      'Webhook "GitHub": comment, "Customer replied while waiting"',
    );
    expect(describeWebhook('GitHub', '{"action":"opened","issue":{"title":"Refund NW-7 never arrived","number":7}}')).toBe(
      'Webhook "GitHub": opened, "Refund NW-7 never arrived"',
    );
    expect(describeWebhook('Shop', '{"event":"order.paid"}')).toBe('Webhook "Shop": order paid');
    expect(describeWebhook('Shop', '{"id":1}')).toBe('Webhook "Shop" received a delivery');
    expect(describeWebhook('Shop', 'plain text\nsecond line')).toBe('Webhook "Shop": plain text');
    expect(describeWebhook('Shop', '')).toBe('Webhook "Shop" received a delivery');
  });

  it('the agent still gets what was sent', () => {
    const text = '{"action":"comment","body":"Customer replied"}';
    const msg = wakeMessage('brief', [
      { source: 'webhook', summary: describeWebhook('GitHub', text), payload: { text }, createdAt: new Date('2026-10-06T10:00:00Z') } as any,
    ]);
    expect(msg).toContain('Webhook "GitHub": comment, "Customer replied"');
    expect(msg).toContain(`What was sent: ${text}`);
  });
});
