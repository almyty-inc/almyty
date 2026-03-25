"""
Test almyty agent via OpenAI Python SDK.

Usage:
  pip install openai
  python test-openai-sdk.py --url https://api.staging.apif.ai --api-key <key> --agent-name new-agent

This proves any OpenAI SDK can target almyty agents.
"""
import argparse
from openai import OpenAI

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--api-key', required=True)
parser.add_argument('--agent-name', default='new-agent')
parser.add_argument('--stream', action='store_true')
args = parser.parse_args()

client = OpenAI(base_url=f"{args.url}/v1", api_key=args.api_key)

print("=== Test 1: List models ===")
models = client.models.list()
for m in models.data:
    print(f"  {m.id} ({m.owned_by})")

print(f"\n=== Test 2: Chat completion (sync) ===")
response = client.chat.completions.create(
    model=f"agent:{args.agent_name}",
    messages=[{"role": "user", "content": "Say hello in 3 words"}],
)
print(f"  Response: {response.choices[0].message.content}")
print(f"  Tokens: {response.usage.total_tokens}")
print(f"  Model: {response.model}")

if args.stream:
    print(f"\n=== Test 3: Chat completion (streaming) ===")
    stream = client.chat.completions.create(
        model=f"agent:{args.agent_name}",
        messages=[{"role": "user", "content": "Count 1 to 5"}],
        stream=True,
    )
    full = ""
    for chunk in stream:
        if chunk.choices[0].delta.content:
            full += chunk.choices[0].delta.content
            print(chunk.choices[0].delta.content, end="", flush=True)
    print(f"\n  Full: {full}")

print("\n=== ALL TESTS PASSED ===")
