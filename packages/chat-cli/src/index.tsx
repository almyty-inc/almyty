#!/usr/bin/env node

import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { AlmytyClient, GatewayClient, AgentInfo, AgentRun, resolveCredentialsOrExit, getOrgSlugFromToken } from '@almyty/client';

const VERSION = '0.1.5';

let exitMessage = '';

// ── Types ───────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'agent' | 'error' | 'info' | 'tool';
  text: string;
}

interface AppState {
  agent: AgentInfo;
  messages: Message[];
  loading: boolean;
  loadingLabel: string;
  conversationId: string | null;
  pendingRunId: string | null;
}

// ── Slash command resolution ────────────────────────────────────

const SLASH_COMMANDS = ['agents', 'help', 'clear', 'quit'] as const;
const ALIASES: Record<string, string> = {
  agent: 'agents', ag: 'agents', switch: 'agents', sw: 'agents',
  h: 'help', '?': 'help',
  cls: 'clear', c: 'clear',
  exit: 'quit', q: 'quit',
};

function resolveSlash(input: string): string | null {
  const name = input.toLowerCase();
  if ((SLASH_COMMANDS as readonly string[]).includes(name)) return name;
  if (ALIASES[name]) return ALIASES[name];
  const prefixed = SLASH_COMMANDS.filter(c => c.startsWith(name));
  if (prefixed.length === 1) return prefixed[0];
  return null;
}

function getSuggestion(partial: string): string {
  if (!partial.startsWith('/') || partial.includes(' ')) return '';
  const p = partial.slice(1).toLowerCase();
  if (!p) return '';
  const match = SLASH_COMMANDS.find(c => c.startsWith(p) && c !== p);
  return match ? `/${match}` : '';
}

// ── Simple markdown rendering ───────────────────────────────────

function MarkdownText({ children }: { children: string }) {
  const lines = children.split('\n');
  const elements: React.ReactElement[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        inCode = false;
        elements.push(
          <Box key={`code-${i}`} flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
            {codeLines.map((cl, j) => (
              <Text key={j} color="white" backgroundColor="#333">{`  ${cl}  `}</Text>
            ))}
          </Box>
        );
      }
      continue;
    }

    if (inCode) { codeLines.push(line); continue; }

    // Headers
    const hm = line.match(/^(#{1,3})\s+(.*)/);
    if (hm) {
      elements.push(<Text key={i} bold color="#8b5cf6">{hm[2]}</Text>);
      continue;
    }

    // Unordered list
    const ulm = line.match(/^(\s*)[*-]\s+(.*)/);
    if (ulm) {
      elements.push(<Text key={i}>{ulm[1]}<Text color="#8b5cf6">•</Text> <InlineFormat text={ulm[2]} /></Text>);
      continue;
    }

    // Ordered list
    const olm = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olm) {
      elements.push(<Text key={i}>{olm[1]}<Text dimColor>{olm[2]}.</Text> <InlineFormat text={olm[3]} /></Text>);
      continue;
    }

    // Blank
    if (!line.trim()) {
      elements.push(<Text key={i}> </Text>);
      continue;
    }

    elements.push(<Text key={i}><InlineFormat text={line} /></Text>);
  }

  return <Box flexDirection="column">{elements}</Box>;
}

function InlineFormat({ text }: { text: string }) {
  // Simple bold/code rendering via split
  const parts: React.ReactElement[] = [];
  let remaining = text;
  let idx = 0;

  while (remaining) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<Text key={idx++}>{boldify(codeMatch[1])}</Text>);
      parts.push(<Text key={idx++} backgroundColor="#333" color="white">{` ${codeMatch[2]} `}</Text>);
      remaining = codeMatch[3];
      continue;
    }
    parts.push(<Text key={idx++}>{boldify(remaining)}</Text>);
    break;
  }

  return <>{parts}</>;
}

function boldify(text: string): React.ReactElement {
  const parts: React.ReactElement[] = [];
  let remaining = text;
  let idx = 0;

  while (remaining) {
    const bm = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/);
    if (bm) {
      if (bm[1]) parts.push(<Text key={idx++}>{bm[1]}</Text>);
      parts.push(<Text key={idx++} bold>{bm[2]}</Text>);
      remaining = bm[3];
      continue;
    }
    parts.push(<Text key={idx++}>{remaining}</Text>);
    break;
  }

  return <>{parts}</>;
}

// ── Message window (manual scroll) ──────────────────────────────

function estimateLines(msg: Message, cols: number): number {
  const textWidth = Math.max(cols - 10, 20);
  const lines = msg.text.split('\n');
  let total = 1; // margin
  for (const line of lines) {
    total += Math.max(1, Math.ceil(Math.max(line.length, 1) / textWidth));
  }
  return total;
}

function MessageWindow({ messages, loading, loadingLabel, maxRows }: {
  messages: Message[];
  loading: boolean;
  loadingLabel: string;
  maxRows: number;
}) {
  const cols = process.stdout.columns || 80;
  const available = Math.max(maxRows, 5);

  // Walk backwards — always show at least the last message
  let usedRows = loading ? 2 : 0;
  let startIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const est = estimateLines(messages[i], cols);
    if (usedRows + est > available && i < messages.length - 1) break;
    usedRows += est;
    startIdx = i;
  }

  const visible = messages.slice(startIdx);

  return (
    <Box flexDirection="column">
      {startIdx > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>↑ {startIdx} earlier message{startIdx > 1 ? 's' : ''}</Text>
        </Box>
      )}
      {visible.map((msg, i) => (
        <MessageView key={startIdx + i} msg={msg} />
      ))}
      {loading && <LoadingIndicator label={loadingLabel} />}
    </Box>
  );
}

// ── Components ──────────────────────────────────────────────────

function Header({ agent, conversationId }: { agent: AgentInfo; conversationId?: string | null }) {
  return (
    <Box borderStyle="round" borderColor="#555" paddingX={1} flexDirection="column">
      <Text>
        <Text color="#22d3ee">⚡</Text>
        <Text color="#8b5cf6" bold> almyty</Text>
        <Text dimColor> · </Text>
        <Text bold>{agent.name}</Text>
        <Text dimColor>  {agent.mode}</Text>
        {conversationId && <Text dimColor>  {conversationId.slice(0, 8)}</Text>}
      </Text>
      {agent.description && <Text dimColor>{agent.description}</Text>}
    </Box>
  );
}

function MessageView({ msg }: { msg: Message }) {
  switch (msg.role) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text dimColor>❯ </Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'agent':
      return (
        <Box marginTop={1} paddingLeft={2} flexDirection="row">
          <Box flexShrink={0}><Text color="#8b5cf6">│ </Text></Box>
          <Box flexDirection="column" flexGrow={1}>
            <MarkdownText>{msg.text}</MarkdownText>
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box paddingLeft={2}>
          <Text dimColor>│ </Text>
          <Text dimColor>▸ </Text>
          <Text color="cyan">{msg.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text color="red">│ </Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'info':
      return (
        <Box paddingLeft={2}>
          <Text dimColor>│ {msg.text}</Text>
        </Box>
      );
    default:
      return null;
  }
}

function LoadingIndicator({ label }: { label: string }) {
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text color="#8b5cf6"><Spinner type="dots" /></Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

// ── Agent selector ──────────────────────────────────────────────

function AgentSelector({ agents, onSelect }: { agents: AgentInfo[]; onSelect: (a: AgentInfo) => void }) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor(c => (c - 1 + agents.length) % agents.length);
    if (key.downArrow) setCursor(c => (c + 1) % agents.length);
    if (key.return) onSelect(agents[cursor]);
  });

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text dimColor>  Select an agent:</Text>
      <Text> </Text>
      {agents.map((ag, i) => (
        <Box key={ag.id} paddingLeft={2}>
          <Text color={i === cursor ? '#8b5cf6' : undefined}>
            {i === cursor ? '❯' : ' '}{' '}
          </Text>
          <Text bold={i === cursor}>{ag.name}</Text>
          <Text dimColor> {ag.mode}</Text>
        </Box>
      ))}
      {agents[cursor]?.description && (
        <Box paddingLeft={4} paddingTop={1}>
          <Text dimColor>{agents[cursor].description}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Chat app ────────────────────────────────────────────────────

function ChatApp({ client, initialAgent, gw }: { client: AlmytyClient; initialAgent: AgentInfo; gw: GatewayClient }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<AppState>({
    agent: initialAgent,
    messages: [],
    loading: false,
    loadingLabel: 'Thinking',
    conversationId: null,
    pendingRunId: null,
  });
  const [input, setInput] = useState('');
  const [paletteCursor, setPaletteCursor] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAgents, setPickerAgents] = useState<AgentInfo[]>([]);

  // Command palette matches
  const slashMatches = input.startsWith('/') && !input.includes(' ')
    ? SLASH_COMMANDS.filter(c => c.startsWith(input.slice(1).toLowerCase()))
    : [];
  const paletteOpen = input.startsWith('/') && slashMatches.length > 0;

  // Arrow key navigation for command palette
  useInput((ch, key) => {
    if (!paletteOpen || state.loading) return;
    if (key.upArrow) {
      setPaletteCursor(c => (c - 1 + slashMatches.length) % slashMatches.length);
    }
    if (key.downArrow) {
      setPaletteCursor(c => (c + 1) % slashMatches.length);
    }
    if (key.tab) {
      setInput(`/${slashMatches[paletteCursor]}`);
      setPaletteCursor(0);
    }
  });

  // Reset palette cursor when input changes
  const handleInputChange = useCallback((val: string) => {
    setInput(val);
    setPaletteCursor(0);
  }, []);

  const addMessage = useCallback((msg: Message) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
  }, []);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setInput('');

    // Slash commands
    if (trimmed.startsWith('/')) {
      const [raw, ...args] = trimmed.slice(1).split(/\s+/);
      const cmd = resolveSlash(raw);

      if (!cmd) {
        addMessage({ role: 'error', text: `Unknown command: /${raw}` });
        addMessage({ role: 'info', text: `Commands: /help /agents /clear /quit` });
        return;
      }

      if (cmd !== raw.toLowerCase() && !Object.entries(ALIASES).some(([k, v]) => k === raw.toLowerCase() && v === cmd)) {
        addMessage({ role: 'info', text: `→ /${cmd}` });
      }

      switch (cmd) {
        case 'quit':
          const agentRef = `${gw.orgSlug}/${gw.agentSlug}`;
          exitMessage = state.conversationId
            ? `\nTo resume: npx @almyty/chat ${agentRef} --resume ${state.conversationId}\n`
            : '';
          exit();
          return;
        case 'clear':
          setState(s => ({ ...s, messages: [] }));
          return;
        case 'help':
          addMessage({ role: 'info', text: '/agents  browse and switch agents' });
          addMessage({ role: 'info', text: '/clear   clear conversation' });
          addMessage({ role: 'info', text: '/help    show this help' });
          addMessage({ role: 'info', text: '/quit    exit' });
          addMessage({ role: 'info', text: 'Tab to autocomplete commands.' });
          return;
        case 'agents': {
          const target = args.join(' ').trim();
          if (target) {
            setState(s => ({ ...s, loading: true, loadingLabel: 'Switching' }));
            const found = await client.findAgentByNameOrId(target);
            setState(s => ({ ...s, loading: false }));
            if (!found) {
              addMessage({ role: 'error', text: `Agent "${target}" not found` });
              return;
            }
            setState(s => ({
              ...s,
              agent: found,
              messages: [],
              conversationId: null,
              pendingRunId: null,
            }));
            return;
          }
          setState(s => ({ ...s, loading: true, loadingLabel: 'Loading' }));
          const agents = await client.listAgents();
          setState(s => ({ ...s, loading: false }));
          setPickerAgents(agents);
          setShowPicker(true);
          return;
        }
      }
      return;
    }

    // Regular message
    addMessage({ role: 'user', text: trimmed });
    setState(s => ({ ...s, loading: true, loadingLabel: 'Thinking' }));

    try {
      if (state.agent.mode === 'autonomous') {
        let runId: string;

        if (state.pendingRunId) {
          await gw.sendRunInput(state.pendingRunId, trimmed);
          runId = state.pendingRunId;
          setState(s => ({ ...s, pendingRunId: null }));
        } else {
          const run = await gw.startRun(trimmed, {
            conversationId: state.conversationId ?? undefined,
          });
          runId = run.id;
          if (run.conversationId) {
            setState(s => ({ ...s, conversationId: run.conversationId! }));
          }
        }

        const result = await gw.pollRun(runId, { intervalMs: 800 });

        setState(s => ({ ...s, loading: false }));

        if (result.status === 'completed' && result.output != null) {
          const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
          addMessage({ role: 'agent', text });
        } else if (result.status === 'waiting_input') {
          setState(s => ({ ...s, pendingRunId: runId }));
          addMessage({ role: 'info', text: 'Waiting for your input' });
        } else if (result.status === 'failed') {
          addMessage({ role: 'error', text: result.error || 'Run failed' });
        }
      } else {
        const result = await gw.invoke({ message: trimmed });
        setState(s => ({ ...s, loading: false }));
        const output = result?.output ?? result?.data?.output ?? result;
        if (output != null) {
          const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
          addMessage({ role: 'agent', text });
        }
      }
    } catch (err: any) {
      setState(s => ({ ...s, loading: false }));
      addMessage({ role: 'error', text: err.message });
    }
  }, [state.agent, state.conversationId, state.pendingRunId, client, addMessage, exit]);

  const handlePickerSelect = useCallback((agent: AgentInfo) => {
    setShowPicker(false);
    if (agent.id === state.agent.id) return;
    setState(s => ({
      ...s,
      agent,
      messages: [],
      conversationId: null,
      pendingRunId: null,
    }));
  }, [state.agent.id]);

  const suggestion = getSuggestion(input);
  const rows = stdout?.rows || 24;

  if (showPicker) {
    return (
      <Box flexDirection="column" height={rows}>
        <Header agent={state.agent} conversationId={state.conversationId} />
        <AgentSelector agents={pickerAgents} onSelect={handlePickerSelect} />
      </Box>
    );
  }

  const COMMAND_DESCS: Record<string, string> = {
    agents: 'browse and switch agents',
    help: 'show commands',
    clear: 'clear conversation',
    quit: 'exit',
  };

  return (
    <Box flexDirection="column" height={rows}>
      {/* Header */}
      <Header agent={state.agent} conversationId={state.conversationId} />

      {/* Messages — manually windowed to prevent overflow */}
      <Box flexDirection="column" flexGrow={1} paddingRight={2}>
        <MessageWindow
          messages={state.messages}
          loading={state.loading}
          loadingLabel={state.loadingLabel}
          maxRows={rows - 7 - (paletteOpen ? slashMatches.length + 1 : 0)}
        />
      </Box>

      {/* Command palette (above input) */}
      {paletteOpen && (
        <Box flexDirection="column" paddingLeft={2} marginBottom={0}>
          {slashMatches.map((cmd, i) => {
            const active = i === paletteCursor;
            return (
              <Text key={cmd}>
                <Text color={active ? '#8b5cf6' : '#555'}>{active ? '❯' : ' '} </Text>
                <Text color="#8b5cf6" bold={active}>/{cmd}</Text>
                <Text dimColor>  {COMMAND_DESCS[cmd] ?? ''}</Text>
              </Text>
            );
          })}
        </Box>
      )}

      {/* Input bar */}
      <Box
        borderStyle="round"
        borderColor={paletteOpen ? '#8b5cf6' : '#555'}
        paddingX={1}
      >
        <Text color="#8b5cf6">❯ </Text>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={handleInputChange}
            onSubmit={(val) => {
              // If palette is open, select the highlighted command
              if (paletteOpen && slashMatches.length > 0) {
                const selected = `/${slashMatches[paletteCursor]}`;
                setInput('');
                setPaletteCursor(0);
                handleSubmit(selected);
                return;
              }
              handleSubmit(val);
            }}
            placeholder="Type a message or / for commands"
          />
        </Box>
      </Box>
    </Box>
  );
}

// ── Entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`almyty chat v${VERSION}\n\nUsage:\n  npx @almyty/chat <org>/<agent-slug>\n  npx @almyty/chat <org>/<agent-slug> --resume <conversation-id>\n\nExamples:\n  npx @almyty/chat acme/support-bot\n  npx @almyty/chat myorg/my-agent --resume 60d93c85-...\n\nCommands:\n  /help /agents /clear /quit\n\nAuth:\n  npx @almyty/auth login`);
    return;
  }

  const creds = resolveCredentialsOrExit();
  const client = new AlmytyClient(creds.url, creds.token);

  let resumeId: string | undefined;
  const ri = Math.max(argv.indexOf('--resume'), argv.indexOf('-resume'));
  if (ri !== -1) {
    resumeId = argv[ri + 1];
    if (!resumeId || resumeId.startsWith('-')) {
      console.error('--resume requires a conversation id');
      process.exit(1);
    }
  }

  const ref = argv.find(arg => !arg.startsWith('-') && arg !== resumeId);

  // Resolve org slug — from ref (org/slug) or JWT token
  const defaultOrg = getOrgSlugFromToken(creds.token);

  let orgSlug: string;
  let agentSlug: string;

  if (ref && ref.includes('/')) {
    [orgSlug, agentSlug] = ref.split('/', 2);
  } else if (ref) {
    // Bare slug — use org from JWT
    if (!defaultOrg) {
      console.error('Cannot determine org. Use org/agent-slug format or log in: npx @almyty/auth login');
      process.exit(1);
    }
    orgSlug = defaultOrg;
    agentSlug = ref;
  } else {
    // No arg — interactive picker
    if (!defaultOrg) {
      console.error('Usage: npx @almyty/chat <org>/<agent-slug>');
      process.exit(1);
    }
    orgSlug = defaultOrg;

    const agents = await client.listAgents();
    if (!agents.length) {
      console.error('No agents found. Create one at https://app.almyty.com/agents');
      process.exit(1);
    }
    if (agents.length === 1) {
      agentSlug = agents[0].slug || agents[0].name.toLowerCase().replace(/\s+/g, '-');
    } else {
      const picked = await new Promise<AgentInfo | null>((resolve) => {
        const { unmount } = render(
          <Box flexDirection="column">
            <Box paddingTop={1} paddingLeft={2}>
              <Text color="#22d3ee">⚡</Text>
              <Text color="#8b5cf6" bold> almyty chat</Text>
            </Box>
            <AgentSelector agents={agents} onSelect={(a) => { unmount(); resolve(a); }} />
          </Box>,
          { exitOnCtrlC: true },
        );
      });
      if (!picked) process.exit(0);
      agentSlug = picked.slug || picked.name.toLowerCase().replace(/\s+/g, '-');
    }
  }

  const gw = client.gateway(orgSlug, agentSlug);

  let agent: AgentInfo;
  try {
    agent = await gw.getInfo();
  } catch {
    console.error(`Agent not found: ${orgSlug}/${agentSlug}`);
    process.exit(1);
  }

  const { waitUntilExit } = render(
    <ChatApp client={client} initialAgent={agent} gw={gw} />,
    { exitOnCtrlC: true },
  );

  await waitUntilExit();

  if (exitMessage) {
    process.stdout.write(exitMessage);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
