import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { AgentInfo } from '@almyty/client';

// ── Types ───────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'agent' | 'error' | 'info' | 'tool';
  text: string;
}

// ── Simple markdown rendering ───────────────────────────────────

export function MarkdownText({ children }: { children: string }) {
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

export function InlineFormat({ text }: { text: string }) {
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

export function boldify(text: string): React.ReactElement {
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

export function estimateLines(msg: Message, cols: number): number {
  const textWidth = Math.max(cols - 10, 20);
  const lines = msg.text.split('\n');
  let total = 1; // margin
  for (const line of lines) {
    total += Math.max(1, Math.ceil(Math.max(line.length, 1) / textWidth));
  }
  return total;
}

export function MessageWindow({ messages, loading, loadingLabel, maxRows, scrollOffset = 0 }: {
  messages: Message[];
  loading: boolean;
  loadingLabel: string;
  maxRows: number;
  scrollOffset?: number;
}) {
  const cols = process.stdout.columns || 80;
  const available = Math.max(maxRows, 5);

  // Calculate the end of the visible window (shifted by scrollOffset)
  const endIdx = Math.max(0, messages.length - scrollOffset);

  // Walk backwards from endIdx to find how many messages fit
  let usedRows = loading && scrollOffset === 0 ? 2 : 0;
  let startIdx = endIdx;

  for (let i = endIdx - 1; i >= 0; i--) {
    const est = estimateLines(messages[i], cols);
    if (usedRows + est > available && i < endIdx - 1) break;
    usedRows += est;
    startIdx = i;
  }

  const visible = messages.slice(startIdx, endIdx);
  const hasEarlier = startIdx > 0;
  const hasLater = endIdx < messages.length;

  return (
    <Box flexDirection="column">
      {hasEarlier && (
        <Box paddingLeft={2}>
          <Text dimColor>↑ {startIdx} earlier · Shift+↑ to scroll</Text>
        </Box>
      )}
      {visible.map((msg, i) => (
        <MessageView key={startIdx + i} msg={msg} />
      ))}
      {loading && scrollOffset === 0 && <LoadingIndicator label={loadingLabel} />}
      {hasLater && (
        <Box paddingLeft={2}>
          <Text dimColor>↓ {messages.length - endIdx} newer · Shift+↓ to scroll</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Components ──────────────────────────────────────────────────

export function Header({ agent, conversationId }: { agent: AgentInfo; conversationId?: string | null }) {
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

export function MessageView({ msg }: { msg: Message }) {
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

export function LoadingIndicator({ label }: { label: string }) {
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text color="#8b5cf6"><Spinner type="dots" /></Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

// ── Agent selector ──────────────────────────────────────────────

export function AgentSelector({ agents, onSelect }: { agents: AgentInfo[]; onSelect: (a: AgentInfo) => void }) {
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
