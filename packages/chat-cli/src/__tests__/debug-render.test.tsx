import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { describe, it } from 'vitest';
import { MessageView } from '../components.js';
import type { Message } from '../components.js';

describe('Debug render', () => {
  it('prints agent message render', () => {
    const msg: Message = { role: 'agent', text: 'Rome is the capital city of Italy and one of the most historically significant cities. Key facts:\n- Known as the Eternal City\n- Population: about 2.8 million\n- Founded in 753 BC' };
    const { lastFrame } = render(
      <Box width={80}>
        <MessageView msg={msg} />
      </Box>
    );
    console.log('=== AGENT MESSAGE ===');
    console.log(lastFrame());
    console.log('=== END ===');
  });

  it('prints palette render', () => {
    const commands = ['agents', 'tools', 'help', 'clear', 'quit'];
    const descs: Record<string, string> = {
      agents: 'browse and switch agents',
      tools: 'show available tools',
      help: 'show commands',
      clear: 'clear conversation',
      quit: 'exit',
    };
    const { lastFrame } = render(
      <Box flexDirection="column" paddingLeft={2} width={60}>
        {commands.map((cmd, i) => {
          const active = i === 0;
          const padded = `/${cmd}`.padEnd(10);
          const desc = descs[cmd] ?? '';
          const line = `${active ? '❯' : ' '} ${padded} ${desc}`;
          return <Text key={cmd} bold={active} wrap="truncate">{line}</Text>;
        })}
      </Box>
    );
    console.log('=== PALETTE ===');
    console.log(lastFrame());
    console.log('=== END ===');
  });
});
