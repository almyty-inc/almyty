"""
Drive an almyty agent with the real OpenAI Python SDK.

Usage:
  pip install openai
  python test-openai-sdk.py --url https://api.staging.almyty.com --api-key <key> --agent-name new-agent

The point of this script is to prove the claim "any OpenAI SDK can target an
almyty agent", so it has to exercise the parts of that claim a happy-path call
does not reach.

A single-message completion cannot see whether the conversation survives the
trip: /v1/chat/completions is stateless, so an endpoint that reads only the
last user line answers a one-shot request perfectly and is amnesiac on every
real chat loop. Hence a multi-turn case whose answer is only possible if the
earlier turns arrived. Likewise the finish_reason, the usage disclosure, the
refusals, and the 401/404/400 shapes an SDK raises on -- an error path that is
never taken is an error path nobody has checked.

Anything red exits non-zero.
"""
import argparse
import sys

import openai
from openai import OpenAI

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--api-key', required=True)
parser.add_argument('--agent-name', default='new-agent')
parser.add_argument('--no-stream', action='store_true', help='skip the streaming cases')
args = parser.parse_args()

BASE = f"{args.url}/v1"
MODEL = f"agent:{args.agent_name}"
client = OpenAI(base_url=BASE, api_key=args.api_key)

FINISH_REASONS = {'stop', 'length', 'tool_calls', 'content_filter', 'function_call'}

failures: list[str] = []


def check(name, condition, detail=''):
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")
        failures.append(name)


def section(title):
    print(f"\n=== {title} ===")


# ── 1. models.list ───────────────────────────────────────────────────────
section('Models list')
models = client.models.list()
ids = [m.id for m in models.data]
print(f"  {len(ids)} model(s): {', '.join(ids[:5])}{' …' if len(ids) > 5 else ''}")
check('models.list returns a list', isinstance(ids, list))

# ── 2. single-turn completion ────────────────────────────────────────────
section('Chat completion (single turn)')
response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Say hello in 3 words"}],
)
choice = response.choices[0]
print(f"  Response: {choice.message.content}")
check('an answer came back', bool(choice.message.content))
check(
    f'finish_reason "{choice.finish_reason}" is a real OpenAI value',
    choice.finish_reason in FINISH_REASONS,
    f'got {choice.finish_reason!r}, expected one of {sorted(FINISH_REASONS)}',
)
check('usage.total_tokens is present', response.usage is not None and response.usage.total_tokens is not None)
check('one choice for n=1', len(response.choices) == 1)

# ── 3. multi-turn — the whole point of a stateless chat API ──────────────
section('Chat completion (multi-turn memory)')
# /v1/chat/completions keeps no state: the messages array IS the conversation,
# and every SDK chat loop resends it whole. If only the last user line reaches
# the agent, this answer cannot contain the name.
multi = client.chat.completions.create(
    model=MODEL,
    messages=[
        {"role": "system", "content": "You are terse. Answer with one word where you can."},
        {"role": "user", "content": "My name is Gwendolyn."},
        {"role": "assistant", "content": "Noted."},
        {"role": "user", "content": "What is my name?"},
    ],
)
answer = (multi.choices[0].message.content or '')
print(f"  Response: {answer}")
check(
    'the agent could see the earlier turns',
    'gwendolyn' in answer.lower(),
    'the answer does not contain the name given two turns earlier, so the conversation did not reach the model',
)

# ── 4. sampling ──────────────────────────────────────────────────────────
section('Sampling parameters are accepted')
sampled = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Name one colour."}],
    temperature=0,
    max_tokens=32,
)
check('temperature=0 and max_tokens are accepted', bool(sampled.choices[0].message.content))

# ── 5. usage disclosure ──────────────────────────────────────────────────
section('Usage reporting is honest about what it measured')
raw = client.chat.completions.with_raw_response.create(
    model=MODEL,
    messages=[{"role": "user", "content": "hello"}],
)
split = raw.headers.get('x-almyty-usage-split')
parsed = raw.parse()
print(f"  x-almyty-usage-split: {split}")
print(f"  usage: {parsed.usage}")
if split == 'unavailable':
    check(
        'the prompt/completion split is not invented when it is not measured',
        parsed.usage.prompt_tokens == 0 and parsed.usage.completion_tokens == 0,
        'the header says the split is unavailable but the fields carry numbers',
    )
else:
    check(
        'prompt + completion adds up to total',
        parsed.usage.prompt_tokens + parsed.usage.completion_tokens == parsed.usage.total_tokens,
    )

# ── 6. refusals ──────────────────────────────────────────────────────────
section('Unsupported fields are refused, by name')
try:
    client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "what is the weather"}],
        tools=[{
            "type": "function",
            "function": {"name": "get_weather", "parameters": {"type": "object", "properties": {}}},
        }],
    )
    check('client-declared tools are refused', False, 'the request was accepted, so the tools would never have fired')
except openai.BadRequestError as err:
    body = getattr(err, 'body', None) or {}
    print(f"  400: {body.get('message') or err}")
    check('client-declared tools are refused with a 400', True)
    check('the refusal names the field', body.get('param') == 'tools', f'param was {body.get("param")!r}')

try:
    client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "give me json"}],
        response_format={"type": "json_object"},
    )
    check('response_format json_object is refused', False, 'accepted, so a json.loads on prose would fail instead')
except openai.BadRequestError:
    check('response_format json_object is refused', True)

# ── 7. error paths ───────────────────────────────────────────────────────
section('Error paths raise the right SDK exception')
try:
    OpenAI(base_url=BASE, api_key='sk-definitely-not-a-real-key').models.list()
    check('a bad key is a 401', False, 'the call succeeded')
except openai.AuthenticationError:
    check('a bad key raises AuthenticationError (401)', True)

try:
    client.chat.completions.create(
        model='agent:this-agent-does-not-exist-9f3c',
        messages=[{"role": "user", "content": "hi"}],
    )
    check('an unknown agent is a 404', False, 'the call succeeded')
except openai.NotFoundError:
    check('an unknown agent raises NotFoundError (404)', True)

try:
    client.chat.completions.create(model=MODEL, messages=[])
    check('an empty messages array is a 400', False, 'the call succeeded')
except openai.BadRequestError:
    check('an empty messages array raises BadRequestError (400)', True)

# ── 8. streaming ─────────────────────────────────────────────────────────
if not args.no_stream:
    section('Streaming')
    stream = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "Count 1 to 5"}],
        stream=True,
        stream_options={"include_usage": True},
    )
    full = ''
    reasons = []
    usage_chunk = None
    for chunk in stream:
        if chunk.usage is not None:
            usage_chunk = chunk.usage
        for c in chunk.choices:
            if c.delta.content:
                full += c.delta.content
            if c.finish_reason:
                reasons.append(c.finish_reason)
    print(f"  Full: {full}")
    check('the stream produced content', bool(full))
    check(
        f'every streamed finish_reason is a real OpenAI value ({reasons})',
        all(r in FINISH_REASONS for r in reasons),
    )
    check(
        'stream_options.include_usage produced a usage-bearing chunk',
        usage_chunk is not None,
        'the spec requires a final chunk carrying usage before [DONE]',
    )

    # A stream against an agent that does not exist fails before the headers
    # go out, so this is the 404 shape on the streaming path.
    try:
        for _ in client.chat.completions.create(
            model='agent:this-agent-does-not-exist-9f3c',
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
        ):
            pass
        check('a streaming request for an unknown agent is a 404', False, 'the call succeeded')
    except openai.NotFoundError:
        check('a streaming request for an unknown agent raises NotFoundError', True)

# ── verdict ──────────────────────────────────────────────────────────────
print()
if failures:
    print(f"=== {len(failures)} CHECK(S) FAILED ===")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print('=== ALL CHECKS PASSED ===')
