import { readableToolName } from '../tool-readable-name';

/** The tool's name in an approval request's sentence is the one the dashboard shows. */
describe('readableToolName', () => {
  it("reads the operation's summary when the spec has one, without its full stop", () => {
    expect(readableToolName({ name: 'northwind_orders_create_refund', operation: { name: 'Issue a refund for an order.' } })).toBe(
      'Issue a refund for an order',
    );
  });

  it('otherwise puts the operation part of the machine name in words', () => {
    expect(readableToolName({ name: 'northwind_orders_create_refund', api: { name: 'Northwind Orders' } })).toBe('Create refund');
    expect(readableToolName({ name: 'issue_refund' })).toBe('Issue refund');
  });

  it("reads a spec's description when its operations have no summary (Google, HubSpot)", () => {
    // The approval said: Ask before “gmail.users.messages.send”.
    expect(
      readableToolName({
        name: 'gmail_gmail_users_messages_send',
        api: { name: 'Gmail' },
        operation: { name: 'gmail.users.messages.send', description: 'Sends the specified message to the recipients in the `To`, `Cc`, and `Bcc` headers. For example usage, see Sending email.' },
      }),
    ).toBe('Sends the specified message to the recipients in the To, Cc, and Bcc headers');
    expect(readableToolName({ name: 'gmail_gmail_users_messages_list', description: "Lists the messages in the user's mailbox." })).toBe("Lists the messages in the user's mailbox");
  });

  it('treats a dotted method id as a machine name, and a long description as no name', () => {
    expect(readableToolName({ name: 'google_tasks_tasks_tasks_list', api: { name: 'Google Tasks' }, operation: { name: 'tasks.tasks.list' } })).toBe('Tasks tasks list');
    expect(readableToolName({ name: 'x_y', description: 'A'.repeat(120) })).toBe('X y');
  });

  it('keeps a name people already wrote', () => {
    expect(readableToolName({ name: 'Refund an order' })).toBe('Refund an order');
    expect(readableToolName({ name: 'x', operation: { name: 'GET /refunds/{id}' } })).toBe('x');
  });
});
