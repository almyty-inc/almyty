import { Client } from 'pg';

import { DistributionSecretsOffRow1750810710000 } from '../../migrations/1750810710000-DistributionSecretsOffRow';

/**
 * The migration that takes platform secrets off distribution rows, run
 * against a real Postgres on a `json` column shaped like
 * `agent_app_distributions.configuration`.
 */
const describeOrSkip = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeOrSkip('distribution secrets migration (real Postgres)', () => {
  const schema = 'distsecretsmig';
  let db: Client;

  beforeAll(async () => {
    db = new Client({
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await db.connect();
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query('DROP TABLE IF EXISTS agent_app_distributions');
    await db.query('CREATE TABLE agent_app_distributions (id text PRIMARY KEY, "configuration" json)');
  }, 30_000);

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it('drops every inline secret, keeps the rest, and leaves clean and empty rows alone', async () => {
    const rows: Array<[string, unknown]> = [
      ['slack', { bot_token: 'xoxb-1', signingSecret: 's', agentId: 'agent-1' }],
      ['sms', { twilio_account_sid: 'AC1', twilio_auth_token: 't', phone_number: '+1' }],
      ['moved', { credentialId: 'cred-1', credentialKeys: ['bot_token'] }],
      ['empty', null],
    ];
    for (const [id, configuration] of rows) {
      await db.query('INSERT INTO agent_app_distributions (id, "configuration") VALUES ($1, $2)', [
        id,
        configuration === null ? null : JSON.stringify(configuration),
      ]);
    }

    await new DistributionSecretsOffRow1750810710000().up({ query: (sql: string, params?: any[]) => db.query(sql, params).then((r) => r.rows) } as any);

    const read = async (id: string) =>
      (await db.query('SELECT "configuration" FROM agent_app_distributions WHERE id = $1', [id])).rows[0].configuration;
    expect(await read('slack')).toEqual({ agentId: 'agent-1' });
    expect(await read('sms')).toEqual({ twilio_account_sid: 'AC1', phone_number: '+1' });
    expect(await read('moved')).toEqual({ credentialId: 'cred-1', credentialKeys: ['bot_token'] });
    expect(await read('empty')).toBeNull();
  });
});
