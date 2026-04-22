import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { describe, it, expect } from 'vitest';
import { Header, MessageView, LoadingIndicator } from '../components.js';
import type { Message } from '../components.js';
import { COMMAND_DESCS } from '../commands.js';

/**
 * Layout tests — render the same structure as ChatApp
 * to verify messages don't merge, text doesn't truncate,
 * and the command palette renders correctly.
 */

function ChatLayout({ messages, showPalette = false, paletteCommands = [] as string[], paletteCursor = 0 }: {
  messages: Message[];
  showPalette?: boolean;
  paletteCommands?: string[];
  paletteCursor?: number;
}) {
  return (
    <Box flexDirection="column" height={40} width={80}>
      <Header agent={{ id: '1', name: 'Test Agent', mode: 'autonomous', description: 'Test desc' }} />

      <Box flexDirection="column" flexGrow={1} paddingRight={2} overflow="hidden">
        {messages.map((msg, i) => (
          <MessageView key={i} msg={msg} />
        ))}
      </Box>

      {showPalette && (
        <Box flexDirection="column" paddingLeft={2}>
          {paletteCommands.map((cmd, i) => {
            const active = i === paletteCursor;
            const padded = `/${cmd}`.padEnd(10);
            const desc = COMMAND_DESCS[cmd] ?? '';
            const line = `${active ? '❯' : ' '} ${padded} ${desc}`;
            return <Text key={cmd} color={active ? '#8b5cf6' : undefined} bold={active} wrap="truncate">{line}</Text>;
          })}
        </Box>
      )}

      <Box>
        <Text dimColor>{'─'.repeat(60)}</Text>
      </Box>

      <Box paddingX={1} paddingY={1}>
        <Text color="#8b5cf6">❯ </Text>
        <Text>input here</Text>
      </Box>

      <Box paddingX={1}>
        <Text dimColor>Test Agent · autonomous</Text>
      </Box>
    </Box>
  );
}

describe('ChatLayout', () => {
  it('should render header, messages, separator, and input without merging', () => {
    const messages: Message[] = [
      { role: 'user', text: 'Hello' },
      { role: 'agent', text: 'Hi there! How can I help?' },
    ];
    const { lastFrame } = render(<ChatLayout messages={messages} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Test Agent');
    expect(frame).toContain('Hello');
    expect(frame).toContain('Hi there');
    expect(frame).toContain('─────');
    expect(frame).toContain('input here');
    expect(frame).toContain('autonomous');
  });

  it('should keep messages on separate lines', () => {
    const messages: Message[] = [
      { role: 'user', text: 'First question' },
      { role: 'agent', text: 'First answer' },
      { role: 'user', text: 'Second question' },
      { role: 'agent', text: 'Second answer' },
    ];
    const { lastFrame } = render(<ChatLayout messages={messages} />);
    const lines = lastFrame()!.split('\n');

    const firstQ = lines.findIndex(l => l.includes('First question'));
    const firstA = lines.findIndex(l => l.includes('First answer'));
    const secondQ = lines.findIndex(l => l.includes('Second question'));
    const secondA = lines.findIndex(l => l.includes('Second answer'));

    expect(firstQ).toBeGreaterThan(-1);
    expect(firstA).toBeGreaterThan(firstQ);
    expect(secondQ).toBeGreaterThan(firstA);
    expect(secondA).toBeGreaterThan(secondQ);
  });

  it('should render command palette with each command on its own line', () => {
    const { lastFrame } = render(
      <ChatLayout
        messages={[]}
        showPalette
        paletteCommands={['agents', 'tools', 'help', 'clear', 'quit']}
        paletteCursor={0}
      />
    );
    const frame = lastFrame()!;
    const lines = frame.split('\n');

    // Each command should appear on a different line
    const agentsLine = lines.findIndex(l => l.includes('/agents'));
    const toolsLine = lines.findIndex(l => l.includes('/tools'));
    const helpLine = lines.findIndex(l => l.includes('/help'));
    const clearLine = lines.findIndex(l => l.includes('/clear'));
    const quitLine = lines.findIndex(l => l.includes('/quit'));

    expect(agentsLine).toBeGreaterThan(-1);
    expect(toolsLine).toBeGreaterThan(agentsLine);
    expect(helpLine).toBeGreaterThan(toolsLine);
    expect(clearLine).toBeGreaterThan(helpLine);
    expect(quitLine).toBeGreaterThan(clearLine);
  });

  it('should not merge palette descriptions across lines', () => {
    const { lastFrame } = render(
      <ChatLayout
        messages={[]}
        showPalette
        paletteCommands={['agents', 'tools', 'help', 'clear', 'quit']}
      />
    );
    const frame = lastFrame()!;

    // These garbled strings appeared in bugs — they should NEVER appear
    expect(frame).not.toContain('toolsger');
    expect(frame).not.toContain('commandsle');
    expect(frame).not.toContain('exitar');
    expect(frame).not.toContain('quitr');

    // Each description should be intact
    expect(frame).toContain('browse and switch agents');
    expect(frame).toContain('show available tools');
    expect(frame).toContain('show commands');
    expect(frame).toContain('clear conversation');
    expect(frame).toContain('exit');
  });

  it('should wrap long agent text instead of truncating', () => {
    const longText = 'Rome is the capital city of Italy and one of the most historically significant cities in the world. It was founded in 753 BC.';
    const { lastFrame } = render(
      <ChatLayout messages={[{ role: 'agent', text: longText }]} />
    );
    const frame = lastFrame()!;

    // All key words should appear — none truncated
    expect(frame).toContain('Rome');
    expect(frame).toContain('capital');
    expect(frame).toContain('Italy');
    expect(frame).toContain('historically');
    expect(frame).toContain('753 BC');
  });

  it('should render separator line between messages and input', () => {
    const { lastFrame } = render(
      <ChatLayout messages={[{ role: 'user', text: 'test' }]} />
    );
    const frame = lastFrame()!;
    const lines = frame.split('\n');

    const testLine = lines.findIndex(l => l.includes('❯ test'));
    const sepLine = lines.findIndex(l => l.match(/^─+$/) !== null);
    const inputLine = lines.findIndex(l => l.includes('input here'));
    expect(sepLine).toBeGreaterThan(testLine);
    expect(inputLine).toBeGreaterThan(sepLine);
  });
});
