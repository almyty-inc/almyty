/**
 * Test almyty agent via OpenAI Node.js SDK.
 * Usage: npx ts-node scripts/test-openai-sdk.ts --url https://api.staging.almyty.com --api-key <key>
 */
import OpenAI from 'openai';

const args = process.argv.slice(2);
const url = args[args.indexOf('--url') + 1] || 'https://api.staging.almyty.com';
const apiKey = args[args.indexOf('--api-key') + 1] || '';
const agentName = args[args.indexOf('--agent-name') + 1] || 'new-agent';

const client = new OpenAI({ baseURL: `${url}/v1`, apiKey });

async function main() {
  console.log('=== Test 1: List models ===');
  const models = await client.models.list();
  for (const m of models.data) console.log(`  ${m.id} (${m.owned_by})`);

  console.log('\n=== Test 2: Chat completion ===');
  const response = await client.chat.completions.create({
    model: `agent:${agentName}`,
    messages: [{ role: 'user', content: 'Say hello in 3 words' }],
  });
  console.log(`  Response: ${response.choices[0].message.content}`);
  console.log(`  Tokens: ${response.usage?.total_tokens}`);

  console.log('\n=== ALL TESTS PASSED ===');
}

main().catch(console.error);
