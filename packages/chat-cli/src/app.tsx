import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AlmytyClient, GatewayClient, AgentInfo, StreamEvent } from '@almyty/client';

import type { Message, Choice } from './components.js';
import {
  Header,
  MessageWindow,
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
  continuationOf,
  buildCodeChoices,
  type CodeChoice,
} from './commands.js';
import { explainError, type ErrorContext } from './errors.js';
import { addUsage, formatUsage, type Usage } from './stream.js';
import { runTurn, type TurnResult } from './turn.js';
import { appendHistory, loadHistory, walkHistory } from './history.js';
import { usableRows } from './viewport.js';

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

/** Rows the header, separator, prompt and status bar take off the top. */
const CHROME_ROWS = 10;

// ── Chat app ────────────────────────────────────────────────────

export function ChatApp({ client, initialAgent, gw, resumeConversationId, errorContext }: {
  client: AlmytyClient;
  initialAgent: AgentInfo;
  gw: GatewayClient;
  resumeConversationId?: string;
  errorContext?: ErrorContext;
}) {
  const { exit } = useApp();
  const agentRef = `${gw.orgSlug}/${gw.agentSlug}`;
  const errCtx: ErrorContext = { agentRef, ...errorContext };
  const [state, setState] = useState<AppState>({
    agent: initialAgent,
    messages: [],
    loading: false,
    loadingLabel: 'Thinking',
    conversationId: resumeConversationId ?? null,
    pendingRunId: null,
  });

  // Assistant text arriving right now, drawn below the transcript and
  // committed as a message when the turn ends.
  const [streaming, setStreaming] = useState('');
  const [sessionUsage, setSessionUsage] = useState<Usage>({ cost: 0, tokens: 0, steps: 0 });
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  // Lines of a message being typed across several Enter presses.
  const [draft, setDraft] = useState<string[]>([]);
  // Redrawn on resize so the visible window matches the new size.
  const [size, setSize] = useState({ rows: process.stdout.rows, columns: process.stdout.columns });

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
      } catch (err) {
        setState(s => ({
          ...s,
          loading: false,
          messages: [...s.messages, { role: 'error', text: explainError(err, { ...errCtx, what: 'history' }) }],
        }));
      }
    })();
  }, [resumeConversationId]);

  // ink redraws on resize, but the window arithmetic needs the new
  // numbers in state to recompute with them.
  useEffect(() => {
    const onResize = () => setSize({ rows: process.stdout.rows, columns: process.stdout.columns });
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);

  const [input, setInput] = useState('');
  const [paletteCursor, setPaletteCursor] = useState(0);
  // Input history persisted across sessions, so up-arrow works in a
  // fresh session and survives /clear.
  const [inputHistory, setInputHistory] = useState<string[]>(() => loadHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAgents, setPickerAgents] = useState<AgentInfo[]>([]);
  // Active coding session (input routes to the runner while set).
  const [coding, setCoding] = useState<CodingSessionState | null>(null);
  // Pending runner x CLI pick for /code when multiple targets exist.
  const [codeChoices, setCodeChoices] = useState<{ choices: CodeChoice[]; task: string } | null>(null);
  const codingAbortRef = useRef<AbortController | null>(null);
  // The in-flight turn, so Ctrl-C can stop it server-side.
  const runAbortRef = useRef<AbortController | null>(null);

  // Command palette matches
  const slashMatches = input.startsWith('/') && !input.includes(' ')
    ? SLASH_COMMANDS.filter(c => c.startsWith(input.slice(1).toLowerCase()))
    : [];
  const paletteOpen = input.startsWith('/') && slashMatches.length > 0;

  const addMessage = useCallback((msg: Message) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
  }, []);

  const quit = useCallback(() => {
    setState(s => {
      exitMessage = s.conversationId
        ? `\nTo resume: almyty chat ${agentRef} --resume ${s.conversationId}\n`
        : '';
      return s;
    });
    exit();
  }, [exit, agentRef]);

  useInput((ch, key) => {
    // Ctrl-C and Ctrl-D come first: they have to work while a run is in
    // flight, which is the only moment cancelling means anything.
    if (key.ctrl && ch === 'c') {
      if (runAbortRef.current) {
        // Cancels the run where it runs, not just where it is watched.
        runAbortRef.current.abort();
        runAbortRef.current = null;
        return;
      }
      if (codingAbortRef.current) {
        codingAbortRef.current.abort();
        codingAbortRef.current = null;
        setCoding(null);
        addMessage({ role: 'info', text: 'left coding mode (the session keeps running)' });
        return;
      }
      if (input) {
        setInput('');
        setDraft([]);
        return;
      }
      quit();
      return;
    }
    if (key.ctrl && ch === 'd') {
      quit();
      return;
    }

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
    if (key.upArrow) {
      const walked = walkHistory(inputHistory, historyIdx, 'up');
      setHistoryIdx(walked.idx);
      if (walked.value) setInput(walked.value);
      return;
    }
    if (key.downArrow) {
      const walked = walkHistory(inputHistory, historyIdx, 'down');
      setHistoryIdx(walked.idx);
      setInput(walked.value);
      return;
    }
  });

  // Reset palette cursor when input changes
  const handleInputChange = useCallback((val: string) => {
    setInput(val);
    setPaletteCursor(0);
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
        addMessage({ role: 'error', text: `coding stream lost: ${explainError(err, errCtx)}` });
        codingAbortRef.current = null;
        setCoding(null);
      });
    } catch (err: any) {
      setState(s => ({ ...s, loading: false }));
      addMessage({ role: 'error', text: explainError(err, errCtx) });
    }
  }, [client, addMessage, appendCodingOutput]);

  /** Detach from coding mode (abort the stream; the remote session is untouched). */
  const leaveCodingMode = useCallback((note: string) => {
    codingAbortRef.current?.abort();
    codingAbortRef.current = null;
    setCoding(null);
    addMessage({ role: 'info', text: note });
  }, [addMessage]);

  // ── Turns ───────────────────────────────────────────────────────

  /** Send one message and stream the answer into the transcript. */
  const sendMessage = useCallback(async (text: string) => {
    addMessage({ role: 'user', text });
    setStreaming('');
    setState(s => ({ ...s, loading: true, loadingLabel: 'Thinking' }));

    const ac = new AbortController();
    runAbortRef.current = ac;

    let result: TurnResult | undefined;
    try {
      result = await runTurn(gw, text, {
        mode: state.agent.mode,
        conversationId: state.conversationId ?? undefined,
        pendingRunId: state.pendingRunId ?? undefined,
        signal: ac.signal,
        hooks: {
          partial: setStreaming,
          activity: (activity) => addMessage(activity),
          label: (label) => setState(s => ({ ...s, loadingLabel: label })),
        },
      });
    } catch (err) {
      runAbortRef.current = null;
      setStreaming('');
      setState(s => ({ ...s, loading: false, pendingRunId: null }));
      addMessage({ role: 'error', text: explainError(err, { ...errCtx, what: 'run' }) });
      return;
    }

    runAbortRef.current = null;
    setStreaming('');
    setState(s => ({
      ...s,
      loading: false,
      conversationId: result!.conversationId ?? s.conversationId,
      pendingRunId: result!.pendingRunId ?? null,
    }));
    if (result.runId) setLastRunId(result.runId);
    setSessionUsage(u => addUsage(u, result!.usage));

    if (result.text) addMessage({ role: 'agent', text: result.text });

    const attribution = formatUsage(result.usage);
    if (attribution) addMessage({ role: 'info', text: attribution });

    if (result.status === 'failed') {
      addMessage({ role: 'error', text: result.error ?? 'The run failed' });
    } else if (result.status === 'cancelled') {
      addMessage({ role: 'info', text: 'cancelled — the run was stopped server-side too' });
    } else if (result.status === 'waiting_input') {
      addMessage({ role: 'info', text: 'the agent is waiting for your answer' });
    }
  }, [state.agent.mode, state.conversationId, state.pendingRunId, gw, addMessage]);

  const handleSubmit = useCallback(async (value: string) => {
    // A line ending in a backslash keeps the message open.
    const continuation = continuationOf(value);
    if (continuation !== null) {
      setDraft(d => [...d, continuation]);
      setInput('');
      return;
    }

    const submitted = draft.length ? [...draft, value].join('\n') : value;
    if (draft.length) setDraft([]);

    const trimmed = submitted.trim();
    if (!trimmed) { setInput(''); return; }
    setInput('');
    setHistoryIdx(-1);
    appendHistory(trimmed);
    setInputHistory(h => (h[h.length - 1] === trimmed ? h : [...h, trimmed]));

    // Slash commands. A multi-line paste is never one, even if its
    // first character is a slash.
    if (classifyInput(trimmed, coding !== null) === 'command') {
      const [raw, ...args] = trimmed.slice(1).split(/\s+/);
      const cmd = resolveSlash(raw);

      if (!cmd) {
        addMessage({ role: 'error', text: `Unknown command: /${raw}` });
        addMessage({ role: 'info', text: '/help lists every command.' });
        return;
      }

      if (cmd !== raw.toLowerCase() && !Object.entries(ALIASES).some(([k, v]) => k === raw.toLowerCase() && v === cmd)) {
        addMessage({ role: 'info', text: `→ /${cmd}` });
      }

      switch (cmd) {
        case 'quit':
          quit();
          return;
        case 'clear':
          // Honest about what it does: the server-side conversation is
          // untouched, so the agent still remembers. /new forgets.
          setState(s => ({ ...s, messages: [] }));
          addMessage({ role: 'info', text: 'transcript cleared on screen — the agent still has this conversation. /new starts a fresh one.' });
          return;
        case 'new':
          setState(s => ({ ...s, messages: [], conversationId: null, pendingRunId: null }));
          setSessionUsage({ cost: 0, tokens: 0, steps: 0 });
          setLastRunId(null);
          addMessage({ role: 'info', text: 'new conversation — the agent has no memory of the last one' });
          return;
        case 'resume':
          if (!state.conversationId) {
            addMessage({ role: 'info', text: 'No conversation yet — send a message first.' });
            return;
          }
          addMessage({ role: 'info', text: `almyty chat ${agentRef} --resume ${state.conversationId}` });
          return;
        case 'cost': {
          const line = formatUsage(sessionUsage);
          addMessage({ role: 'info', text: line ? `this session: ${line}` : 'Nothing spent yet this session.' });
          return;
        }
        case 'model': {
          const config = (state.agent.modelConfig ?? {}) as Record<string, any>;
          const routing = config.routing as Record<string, any> | undefined;
          if (routing) {
            const summary = [routing.role, routing.rationale, routing.strategy].filter(Boolean).join(' · ');
            addMessage({ role: 'info', text: `routed per run${summary ? ` — ${summary}` : ''}; the answering model is shown after each turn` });
          } else if (config.model) {
            addMessage({ role: 'info', text: `${config.model}${config.providerId ? ` · provider ${String(config.providerId).slice(0, 8)}` : ''}` });
          } else {
            addMessage({ role: 'info', text: 'No model configured on this agent. It will not answer until one is chosen in the dashboard.' });
          }
          if (sessionUsage.model) addMessage({ role: 'info', text: `last answered by ${sessionUsage.model}` });
          return;
        }
        case 'trace': {
          if (!lastRunId) {
            addMessage({ role: 'info', text: 'No run to trace yet.' });
            return;
          }
          setState(s => ({ ...s, loading: true, loadingLabel: 'Loading trace' }));
          try {
            const run = await gw.getRun(lastRunId);
            setState(s => ({ ...s, loading: false }));
            const steps = Array.isArray(run.steps) ? run.steps : [];
            if (!steps.length) {
              addMessage({ role: 'info', text: `run ${lastRunId.slice(0, 8)} · ${run.status} · no steps recorded` });
              return;
            }
            addMessage({ role: 'info', text: `run ${lastRunId.slice(0, 8)} · ${run.status} · ${steps.length} step${steps.length === 1 ? '' : 's'}` });
            steps.forEach((step: any, i) => {
              const bits = [step.type];
              if (step.input?.tool) bits.push(step.input.tool);
              if (typeof step.cost === 'number' && step.cost) bits.push(`$${step.cost.toFixed(4)}`);
              if (step.duration) bits.push(`${Math.round(step.duration)}ms`);
              if (step.error) bits.push(`error: ${step.error}`);
              addMessage({ role: step.error ? 'error' : 'tool', text: `${i + 1}. ${bits.join(' · ')}` });
            });
          } catch (err) {
            setState(s => ({ ...s, loading: false }));
            addMessage({ role: 'error', text: explainError(err, errCtx) });
          }
          return;
        }
        case 'help':
          for (const name of SLASH_COMMANDS) {
            addMessage({ role: 'info', text: `/${name.padEnd(11)}${COMMAND_DESCS[name] ?? ''}` });
          }
          addMessage({ role: 'info', text: 'Tab completes · up/down walk history · end a line with \\ to keep typing' });
          addMessage({ role: 'info', text: 'Ctrl-C cancels the running answer, again to exit · Ctrl-D exits' });
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
            try {
              const found = await client.findAgentByNameOrId(target);
              setState(s => ({ ...s, loading: false }));
              if (!found) {
                addMessage({ role: 'error', text: `No agent called "${target}". /agents with no argument lists them.` });
                return;
              }
              setState(s => ({
                ...s,
                agent: found,
                messages: [],
                conversationId: null,
                pendingRunId: null,
              }));
            } catch (err) {
              setState(s => ({ ...s, loading: false }));
              addMessage({ role: 'error', text: explainError(err, errCtx) });
            }
            return;
          }
          setState(s => ({ ...s, loading: true, loadingLabel: 'Loading' }));
          try {
            const agents = await client.listAgents();
            setState(s => ({ ...s, loading: false }));
            setPickerAgents(agents);
            setShowPicker(true);
          } catch (err) {
            setState(s => ({ ...s, loading: false }));
            addMessage({ role: 'error', text: explainError(err, errCtx) });
          }
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
            addMessage({ role: 'error', text: explainError(err, errCtx) });
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
            addMessage({ role: 'error', text: explainError(err, errCtx) });
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
            addMessage({ role: 'error', text: explainError(err, errCtx) });
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
        addMessage({ role: 'error', text: explainError(err, errCtx) });
      }
      return;
    }

    await sendMessage(trimmed);
  }, [state.agent, state.conversationId, state.pendingRunId, client, gw, addMessage, quit, coding, startCoding, leaveCodingMode, sendMessage, draft, sessionUsage, lastRunId, agentRef]);

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

  const transcriptRows = usableRows(size.rows, CHROME_ROWS + (paletteOpen ? slashMatches.length : 0));
  const separatorWidth = Math.min(Math.max(size.columns || 80, 20), 120);
  const sessionLine = formatUsage(sessionUsage);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Header agent={state.agent} conversationId={state.conversationId} />

      {/* Messages, bounded to what the terminal can show */}
      <Box flexDirection="column" paddingRight={2}>
        <MessageWindow
          messages={state.messages}
          loading={state.loading}
          loadingLabel={state.loadingLabel}
          maxRows={transcriptRows}
          streaming={streaming}
        />
      </Box>

      {/* Command palette */}
      {paletteOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          {slashMatches.map((cmd, i) => {
            const active = i === paletteCursor;
            const padded = `/${cmd}`.padEnd(12);
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
        <Text dimColor>{'─'.repeat(separatorWidth)}</Text>
      </Box>

      {/* Input */}
      <Box paddingX={1} paddingY={1}>
        <Text color={coding ? '#22d3ee' : '#8b5cf6'}>{draft.length ? '… ' : '❯ '}</Text>
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
        <Text dimColor wrap="truncate">
          {state.agent.name}
          {state.agent.tools?.length ? ` · ${state.agent.tools.length} tools` : ''}
          {state.conversationId ? ` · ${state.conversationId.slice(0, 8)}` : ''}
          {sessionLine ? ` · ${sessionLine}` : ''}
          {coding ? ` · coding:${coding.agent}@${coding.runnerName}` : ''}
          {state.loading ? ' · ctrl-c cancels' : ''}
        </Text>
      </Box>
    </Box>
  );
}
