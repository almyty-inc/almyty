import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { Header, MessageView, LoadingIndicator } from '../components.js';
import type { Message } from '../components.js';

describe('Header', () => {
  it('should render agent name and mode on one line', () => {
    const { lastFrame } = render(
      <Header agent={{ id: '1', name: 'Test Agent', mode: 'autonomous' }} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('almyty');
    expect(frame).toContain('Test Agent');
    expect(frame).toContain('autonomous');
  });

  it('should render description on a separate line', () => {
    const { lastFrame } = render(
      <Header agent={{ id: '1', name: 'Test', description: 'A test agent' }} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('A test agent');
  });

  it('should render conversation ID when provided', () => {
    const { lastFrame } = render(
      <Header agent={{ id: '1', name: 'Test' }} conversationId="abcd1234-5678" />
    );
    expect(lastFrame()!).toContain('abcd1234');
  });

  it('should not merge header text with description', () => {
    const { lastFrame } = render(
      <Header agent={{ id: '1', name: 'My Agent', mode: 'autonomous', description: 'Does things' }} />
    );
    const lines = lastFrame()!.split('\n');
    // Name and description should be on different lines
    const nameLine = lines.find(l => l.includes('My Agent'));
    const descLine = lines.find(l => l.includes('Does things'));
    expect(nameLine).toBeDefined();
    expect(descLine).toBeDefined();
    expect(nameLine).not.toBe(descLine);
  });
});

describe('MessageView', () => {
  it('should render user message with prompt', () => {
    const msg: Message = { role: 'user', text: 'Hello world' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Hello world');
    expect(frame).toContain('❯');
  });

  it('should render agent message with border', () => {
    const msg: Message = { role: 'agent', text: 'Hi there' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Hi there');
    expect(frame).toContain('│');
  });

  it('should render tool message', () => {
    const msg: Message = { role: 'tool', text: 'web_search' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    expect(lastFrame()!).toContain('web_search');
  });

  it('should render error message', () => {
    const msg: Message = { role: 'error', text: 'Something failed' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    expect(lastFrame()!).toContain('Something failed');
  });

  it('should render info message', () => {
    const msg: Message = { role: 'info', text: 'Waiting for input' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    expect(lastFrame()!).toContain('Waiting for input');
  });

  it('should not merge user text with prompt symbol', () => {
    const msg: Message = { role: 'user', text: 'Test message' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    // The prompt and text should be on the same line, separated properly
    expect(frame).toMatch(/❯.*Test message/);
  });

  it('should render multi-line agent response with border on each conceptual block', () => {
    const msg: Message = { role: 'agent', text: 'Line one\nLine two\nLine three' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Line one');
    expect(frame).toContain('Line two');
    expect(frame).toContain('Line three');
  });

  it('should render markdown bold', () => {
    const msg: Message = { role: 'agent', text: 'This is **bold** text' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    expect(frame).toContain('bold');
    expect(frame).toContain('text');
  });

  it('should render markdown bullet list', () => {
    const msg: Message = { role: 'agent', text: '- Item one\n- Item two' };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Item one');
    expect(frame).toContain('Item two');
    // Should have bullet markers
    expect(frame).toContain('•');
  });

  it('should not truncate agent text on the right', () => {
    const longText = 'This is a fairly long sentence that should wrap properly instead of being truncated at the edge of the terminal window.';
    const msg: Message = { role: 'agent', text: longText };
    const { lastFrame } = render(<MessageView msg={msg} />);
    const frame = lastFrame()!;
    // All words should appear somewhere in the output
    expect(frame).toContain('truncated');
    expect(frame).toContain('terminal');
    expect(frame).toContain('window');
  });
});

describe('LoadingIndicator', () => {
  it('should render label', () => {
    const { lastFrame } = render(<LoadingIndicator label="Thinking" />);
    expect(lastFrame()!).toContain('Thinking');
  });
});

describe('Multiple messages do not merge', () => {
  it('should render two messages on separate lines', () => {
    const { lastFrame } = render(
      <>
        <MessageView msg={{ role: 'user', text: 'Question one' }} />
        <MessageView msg={{ role: 'agent', text: 'Answer one' }} />
        <MessageView msg={{ role: 'user', text: 'Question two' }} />
        <MessageView msg={{ role: 'agent', text: 'Answer two' }} />
      </>
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Question one');
    expect(frame).toContain('Answer one');
    expect(frame).toContain('Question two');
    expect(frame).toContain('Answer two');

    // Each should be on its own line(s), not merged
    const lines = frame.split('\n');
    const q1Line = lines.findIndex(l => l.includes('Question one'));
    const a1Line = lines.findIndex(l => l.includes('Answer one'));
    const q2Line = lines.findIndex(l => l.includes('Question two'));
    expect(a1Line).toBeGreaterThan(q1Line);
    expect(q2Line).toBeGreaterThan(a1Line);
  });
});
