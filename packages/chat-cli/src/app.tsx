import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AlmytyClient, GatewayClient, AgentInfo, StreamEvent } from '@almyty/client';

import type { Message, Choice } from './components.js';
import {
  Header,
  MessageView,
  LoadingIndicator,
  AgentSelector,
  CodingModeIndicator,
  ChoiceSelector,
} from './components.js';
import {
  SLASH_COMMANDS,
  COMMAND_DESCS,
  resolveSlash,
  getSuggestion,
  ALIASES,
  classifyInput,
  buildCodeChoices,
  type CodeChoice,
} from './commands.js';

// ── App state ──────────────────────────────────────────────────

export interface AppState {
  agent: AgentInfo;
  messages: Message[];
  loading: boolean;
  loadingLabel: string;
  conversationId: string | null;
  pendingRunId: string | null;
}

/** Active coding session driven from the REPL (chat-to-runner bridge). */
export interface CodingSessionState {
  runnerId: string;
  runnerName: string;
  agent: string;
  sessionId: string;
}

// Mutable module-level variable; written by ChatApp, read by main() after exit
export let exitMessage = '';

// ── Chat app ────────────────────────────────────────────────────

export function ChatApp({ client, initialAgent, gw, resumeConversationId }: {
  client: AlmytyClient;
  initialAgent: AgentInfo;
  gw: GatewayClient;
  resumeConversationId?: string;
}) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>({
    agent: initialAgent,
    messages: [],
    loading: false,
    loadingLabel: 'Thinking',
    conversationId: resumeConversationId ?? null,
    pendingRunId: null,
  });

  // Load conversation history on resume
  useEffect(() => {
    if (!resumeConversationId) return;
    (async () => {
      setState(s => ({ ...s, loading: true, loadingLabel: 'Loading history' }));
      try {
        const history = await gw.getConversationMessages(resumeConversationId);
        const msgs: Message[] = history
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            role: m.role === 'user' ? 'user' as const : 'agent' as const,
            text: m.content,
          }));
        setState(s => ({ ...s, messages: msgs, loading: false }));
      } catch {
        setState(s => ({ ...s, loading: false }));
      }
    })();
  }, [resumeConversationId]);
  const [input, setInput] = useState('');
  const [paletteCursor, setPaletteCursor] = useState(0);
  // Input history derived from conversation — includes resumed messages
  const inputHistory = state.messages.filter(m => m.role === 'user').map(m => m.text);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAgents, setPickerAgents] = useState<AgentInfo[]>([]);
  // Active coding session (input routes to the runner while set).
  const [coding, setCoding] = useState<CodingSessionState | null>(null);
  // Pending runner x CLI pick for /code when multiple targets exist.
  const [codeChoices, setCodeChoices] = useState<{ choices: CodeChoice[]; task: string } | null>(null);
  const codingAbortRef = useRef<AbortController | null>(null);

  // Command palette matches
  const slashMatches = input.startsWith('/') && !input.includes(' ')
    ? SLASH_COMMANDS.filter(c => c.startsWith(input.slice(1).toLowerCase()))
    : [];
  const paletteOpen = input.startsWith('/') && slashMatches.length > 0;

  useInput((ch, key) => {
    if (state.loading) return;

    // Command palette navigation
    if (paletteOpen) {
      if (key.upArrow) {
        setPaletteCursor(c => (c - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (key.downArrow) {
        setPaletteCursor(c => (c + 1) % slashMatches.length);
        return;
      }
      if (key.tab) {
        setInput(`/${slashMatches[paletteCursor]}`);
        setPaletteCursor(0);
        return;
      }
      return;
    }

    // Input history — up/down arrows always, like Claude Code
    if (key.upArrow && inputHistory.length > 0) {
      const newIdx = Math.min(historyIdx + 1, inputHistory.length - 1);
      setHistoryIdx(newIdx);
      setInput(inputHistory[inputHistory.length - 1 - newIdx]);
      return;
    }
    if (key.downArrow) {
      if (historyIdx > 0) {
        const newIdx = historyIdx - 1;
        setHistoryIdx(newIdx);
        setInput(inputHistory[inputHistory.length - 1 - newIdx]);
      } else if (historyIdx === 0) {
        setHistoryIdx(-1);
        setInput('');
      }
      return;
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

  // ── Coding session helpers (chat-to-runner bridge) ──────────────

  /**
   * Append streamed CLI output to the transcript, merging into the last
   * coding message so a burst of chunks doesn't explode into hundreds of
   * transcript entries. Caps a single coding message before rolling over.
   */
  const appendCodingOutput = useCallback((text: string) => {
    if (!text) return;
    setState(s => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'coding' && last.text.length < 4000) {
        msgs[msgs.length - 1] = { ...last, text: last.text + text };
      } else {
        msgs.push({ role: 'coding', text });
      }
      return { ...s, messages: msgs };
    });
  }, []);

  const startCoding = useCallback(async (choice: CodeChoice, task: string) => {
    setState(s => ({ ...s, loading: true, loadingLabel: `Starting ${choice.agentName} on ${choice.runnerName}` }));
    try {
      const session = await client.startCodingSession(choice.runnerId, {
        agent: choice.agentId,
        task,
      });
      setState(s => ({ ...s, loading: false }));
      setCoding({
        runnerId: choice.runnerId,
        runnerName: choice.runnerName,
        agent: choice.agentId,
        sessionId: session.sessionId,
      });
      addMessage({
        role: 'info',
        text: `coding session started — ${choice.agentId}@${choice.runnerName} (cwd ${session.cwd ?? '~'})`,
      });

      // Background stream: coding.output chunks land in the transcript,
      // coding.exit closes the mode. /esc aborts the stream client-side.
      const ac = new AbortController();
      codingAbortRef.current = ac;
      void client.streamCodingEvents(choice.runnerId, session.sessionId, (event: StreamEvent) => {
        if (event.type === 'coding.output') {
          const chunk = (event.data as any).data;
          if (chunk) appendCodingOutput(String(chunk));
        } else if (event.type === 'coding.exit') {
          const code = (event.data as any).exitCode;
          addMessage({ role: 'info', text: `coding session exited${code != null ? ` (exit ${code})` : ''}` });
          codingAbortRef.current = null;
          setCoding(null);
        }
      }, ac.signal).catch((err: any) => {
        if (ac.signal.aborted) return;
        addMessage({ role: 'error', text: `coding stream lost: ${err.message}` });
        codingAbortRef.current = null;
        setCoding(null);
      });
    } catch (err: any) {
      setState(s => ({ ...s, loading: false }));
      addMessage({ role: 'error', text: err.message });
    }
  }, [client, addMessage, appendCodingOutput]);

  /** Detach from coding mode (abort the stream; the remote session is untouched). */
  const leaveCodingMode = useCallback((note: string) => {
    codingAbortRef.current?.abort();
    codingAbortRef.current = null;
    setCoding(null);
    addMessage({ role: 'info', text: note });
  }, [addMessage]);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setInput('');
    setHistoryIdx(-1);

    // Slash commands
    if (trimmed.startsWith('/')) {
      const [raw, ...args] = trimmed.slice(1).split(/\s+/);
      const cmd = resolveSlash(raw);

      if (!cmd) {
        addMessage({ role: 'error', text: `Unknown command: /${raw}` });
        addMessage({ role: 'info', text: `Commands: /help /agents /runners /code /clear /quit` });
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
          addMessage({ role: 'info', text: '/agents     browse and switch agents' });
          addMessage({ role: 'info', text: '/tools      show available tools' });
          addMessage({ role: 'info', text: '/runners    list your runners + coding CLIs' });
          addMessage({ role: 'info', text: '/code       run a coding task on a runner' });
          addMessage({ role: 'info', text: '/code-stop  stop the active coding session' });
          addMessage({ role: 'info', text: '/esc        leave coding mode (session keeps running)' });
          addMessage({ role: 'info', text: '/clear      clear conversation' });
          addMessage({ role: 'info', text: '/help       show this help' });
          addMessage({ role: 'info', text: '/quit       exit' });
          addMessage({ role: 'info', text: 'Tab to autocomplete commands.' });
          return;
        case 'tools': {
          const tools = state.agent.tools;
          if (!tools?.length) {
            addMessage({ role: 'info', text: 'No tools configured for this agent.' });
            return;
          }
          addMessage({ role: 'info', text: `${tools.length} tool${tools.length > 1 ? 's' : ''} available:` });
          for (const tool of tools) {
            const desc = tool.description ? ` — ${tool.description}` : '';
            addMessage({ role: 'tool', text: `${tool.name}${desc}` });
          }
          return;
        }
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
        case 'runners': {
          setState(s => ({ ...s, loading: true, loadingLabel: 'Loading runners' }));
          try {
            const runners = await client.listRunners();
            setState(s => ({ ...s, loading: false }));
            if (!runners.length) {
              addMessage({ role: 'info', text: 'No runners registered. Start one: npx @almyty/runner start' });
              return;
            }
            for (const r of runners) {
              const clis = (r.codingAgents ?? []).map(a => a.id).join(', ') || 'no coding CLIs detected';
              addMessage({ role: 'info', text: `${r.name} · ${r.state ?? 'unknown'} · ${clis}` });
            }
          } catch (err: any) {
            setState(s => ({ ...s, loading: false }));
            addMessage({ role: 'error', text: err.message });
          }
          return;
        }
        case 'code': {
          const task = args.join(' ').trim();
          if (!task) {
            addMessage({ role: 'error', text: 'Usage: /code <task>' });
            return;
          }
          if (coding) {
            addMessage({ role: 'error', text: 'A coding session is already active — /code-stop or /esc first.' });
            return;
          }
          setState(s => ({ ...s, loading: true, loadingLabel: 'Finding runners' }));
          try {
            const runners = await client.listRunners();
            setState(s => ({ ...s, loading: false }));
            const choices = buildCodeChoices(runners);
            if (!choices.length) {
              addMessage({ role: 'error', text: 'No online runner with a detected coding CLI. Start one: npx @almyty/runner start' });
              return;
            }
            if (choices.length === 1) {
              await startCoding(choices[0], task);
              return;
            }
            setCodeChoices({ choices, task });
          } catch (err: any) {
            setState(s => ({ ...s, loading: false }));
            addMessage({ role: 'error', text: err.message });
          }
          return;
        }
        case 'code-stop': {
          if (!coding) {
            addMessage({ role: 'info', text: 'No active coding session.' });
            return;
          }
          try {
            await client.stopCodingSession(coding.runnerId, coding.sessionId);
          } catch (err: any) {
            addMessage({ role: 'error', text: err.message });
          }
          leaveCodingMode('coding session stopped');
          return;
        }
        case 'esc': {
          if (!coding) {
            addMessage({ role: 'info', text: 'Not in coding mode.' });
            return;
          }
          leaveCodingMode(`left coding mode — session keeps running on ${coding.runnerName} (/code-stop to kill it)`);
          return;
        }
      }
      return;
    }

    // Coding mode: anything that isn't a slash command routes to the
    // session's stdin, not to the chat agent.
    if (classifyInput(trimmed, coding !== null) === 'coding' && coding) {
      addMessage({ role: 'user', text: trimmed });
      try {
        await client.sendCodingInput(coding.runnerId, coding.sessionId, trimmed);
      } catch (err: any) {
        addMessage({ role: 'error', text: err.message });
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

        // Stream events — show tool calls, sub-agents, chunks in real time
        let streamedContent = '';
        const result = await gw.streamRun(runId, (event: StreamEvent) => {
          switch (event.type) {
            case 'llm.started':
              setState(s => ({ ...s, loadingLabel: 'Thinking' }));
              break;
            case 'llm.chunk': {
              const chunk = (event.data as any).content;
              if (chunk) streamedContent += chunk;
              break;
            }
            case 'llm.response':
              setState(s => ({ ...s, loadingLabel: 'Processing' }));
              break;
            case 'tool.started': {
              const toolName = (event.data as any).tool;
              if (toolName) {
                setState(s => ({ ...s, loading: false }));
                addMessage({ role: 'tool', text: toolName });
                setState(s => ({ ...s, loading: true, loadingLabel: `Running ${toolName}` }));
              }
              break;
            }
            case 'tool.result': {
              const tool = (event.data as any).tool;
              const success = (event.data as any).success;
              if (tool) {
                addMessage({ role: 'info', text: `${tool} ${success ? 'completed' : 'failed'}` });
              }
              break;
            }
            case 'step.completed':
              break;
            case 'run.completed': {
              const output = (event.data as any).output;
              if (output) {
                const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
                streamedContent = text;
              }
              break;
            }
            case 'run.failed': {
              const error = (event.data as any).error;
              addMessage({ role: 'error', text: error || 'Run failed' });
              break;
            }
          }
        });

        setState(s => ({ ...s, loading: false }));

        // If still running after stream, poll to completion
        let finalResult = result;
        if (result.status === 'running') {
          finalResult = await gw.pollRun(runId);
        }

        // Show final output
        if (finalResult.status === 'completed') {
          const text = streamedContent
            || (finalResult.output != null ? (typeof finalResult.output === 'string' ? finalResult.output : JSON.stringify(finalResult.output, null, 2)) : '');
          if (text) addMessage({ role: 'agent', text });
        } else if (finalResult.status === 'waiting_input') {
          setState(s => ({ ...s, pendingRunId: runId }));
          addMessage({ role: 'info', text: 'Waiting for your input' });
        } else if (finalResult.status === 'failed' && !streamedContent) {
          addMessage({ role: 'error', text: finalResult.error || 'Run failed' });
        }
      } else {
        // Workflow: synchronous invoke
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
  }, [state.agent, state.conversationId, state.pendingRunId, client, addMessage, exit, coding, startCoding, leaveCodingMode]);

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

  if (showPicker) {
    return (
      <Box flexDirection="column">
        <Header agent={state.agent} conversationId={state.conversationId} />
        <AgentSelector agents={pickerAgents} onSelect={handlePickerSelect} />
      </Box>
    );
  }

  if (codeChoices) {
    const items: Choice[] = codeChoices.choices.map(c => ({
      key: `${c.runnerId}:${c.agentId}`,
      label: c.agentName,
      hint: `on ${c.runnerName}`,
    }));
    return (
      <Box flexDirection="column">
        <Header agent={state.agent} conversationId={state.conversationId} />
        <ChoiceSelector
          title="Pick a coding CLI + runner:"
          choices={items}
          onSelect={(picked) => {
            const choice = codeChoices.choices.find(c => `${c.runnerId}:${c.agentId}` === picked.key);
            const task = codeChoices.task;
            setCodeChoices(null);
            if (choice) void startCoding(choice, task);
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Header agent={state.agent} conversationId={state.conversationId} />

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingRight={2} overflow="hidden">
        {state.messages.map((msg, i) => (
          <MessageView key={i} msg={msg} />
        ))}
        {state.loading && <LoadingIndicator label={state.loadingLabel} />}
      </Box>

      {/* Command palette */}
      {paletteOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          {slashMatches.map((cmd, i) => {
            const active = i === paletteCursor;
            const padded = `/${cmd}`.padEnd(10);
            const desc = COMMAND_DESCS[cmd] ?? '';
            const line = `${active ? '❯' : ' '} ${padded} ${desc}`;
            return <Text key={cmd} color={active ? '#8b5cf6' : undefined} bold={active} wrap="truncate">{line}</Text>;
          })}
        </Box>
      )}

      {/* Coding mode indicator */}
      {coding && <CodingModeIndicator agent={coding.agent} runner={coding.runnerName} />}
      {/* Separator */}
      <Box>
        <Text dimColor>{'─'.repeat(Math.min(process.stdout.columns || 80, 120))}</Text>
      </Box>

      {/* Input */}
      <Box paddingX={1} paddingY={1}>
        <Text color={coding ? '#22d3ee' : '#8b5cf6'}>❯ </Text>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={handleInputChange}
            onSubmit={(val) => {
              if (paletteOpen && slashMatches.length > 0) {
                const selected = `/${slashMatches[paletteCursor]}`;
                setInput('');
                setPaletteCursor(0);
                handleSubmit(selected);
                return;
              }
              handleSubmit(val);
            }}
            placeholder={coding ? 'Type input for the coding session or / for commands' : 'Type a message or / for commands'}
          />
        </Box>
      </Box>

      {/* Status */}
      <Box paddingX={1}>
        <Text dimColor>
          {state.agent.name}
          {state.agent.tools?.length ? ` · ${state.agent.tools.length} tools` : ''}
          {state.conversationId ? ` · ${state.conversationId.slice(0, 8)}` : ''}
          {coding ? ` · coding:${coding.agent}@${coding.runnerName}` : ''}
        </Text>
      </Box>
    </Box>
  );
}
