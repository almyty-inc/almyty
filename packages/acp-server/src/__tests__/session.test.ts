import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../session.js';

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  it('creates a session with a UUID', () => {
    const s = mgr.create('agent-1', 'workflow');
    expect(s.id).toMatch(/^[0-9a-f]{8}-/);
    expect(s.agentId).toBe('agent-1');
    expect(s.mode).toBe('workflow');
    expect(s.lastActivity).toBeGreaterThan(0);
  });

  it('retrieves a session by ID', () => {
    const s = mgr.create('agent-1', 'autonomous');
    expect(mgr.get(s.id)).toBe(s);
  });

  it('returns undefined for unknown session', () => {
    expect(mgr.get('nonexistent')).toBeUndefined();
  });

  it('lists all sessions', () => {
    mgr.create('a1', 'workflow');
    mgr.create('a2', 'autonomous');
    expect(mgr.list()).toHaveLength(2);
  });

  it('updates session fields', () => {
    const s = mgr.create('a1', 'autonomous');
    mgr.update(s.id, { conversationId: 'conv-1', activeRunId: 'run-1' });
    const updated = mgr.get(s.id)!;
    expect(updated.conversationId).toBe('conv-1');
    expect(updated.activeRunId).toBe('run-1');
  });

  it('cancel aborts the controller and clears activeRunId', () => {
    const s = mgr.create('a1', 'autonomous');
    const ac = new AbortController();
    mgr.update(s.id, { abortController: ac, activeRunId: 'run-1' });
    mgr.cancel(s.id);
    expect(ac.signal.aborted).toBe(true);
    expect(mgr.get(s.id)!.activeRunId).toBeUndefined();
  });

  it('close removes the session', () => {
    const s = mgr.create('a1', 'workflow');
    expect(mgr.close(s.id)).toBe(true);
    expect(mgr.get(s.id)).toBeUndefined();
    expect(mgr.close(s.id)).toBe(false);
  });

  it('closeAll aborts all and clears', () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const s1 = mgr.create('a1', 'workflow');
    const s2 = mgr.create('a2', 'autonomous');
    mgr.update(s1.id, { abortController: ac1 });
    mgr.update(s2.id, { abortController: ac2 });
    mgr.closeAll();
    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });

  it('handles concurrent sessions for different agents', () => {
    const s1 = mgr.create('agent-a', 'workflow');
    const s2 = mgr.create('agent-b', 'autonomous');
    const s3 = mgr.create('agent-a', 'autonomous');
    expect(mgr.list()).toHaveLength(3);
    expect(mgr.get(s1.id)!.agentId).toBe('agent-a');
    expect(mgr.get(s2.id)!.agentId).toBe('agent-b');
    expect(mgr.get(s3.id)!.agentId).toBe('agent-a');
  });
});
