import { runMayWriteSharedMemory, shouldAutoSaveMemory } from '../memory-autosave.policy';

describe('shouldAutoSaveMemory', () => {
  it('is off unless the agent opted in', () => {
    expect(shouldAutoSaveMemory({ memoryConfig: undefined } as any, { endUserId: null } as any)).toBe(false);
    expect(shouldAutoSaveMemory({ memoryConfig: { autoSave: false } } as any, { endUserId: null } as any)).toBe(false);
  });

  it('saves an operator run when the agent opted in', () => {
    expect(shouldAutoSaveMemory({ memoryConfig: { autoSave: true } } as any, { endUserId: null } as any)).toBe(true);
  });

  it('never saves a run started by a hosted-chat or widget visitor', () => {
    // Workspace-scoped memory is shared across every later run; a
    // visitor's words must not become part of someone else's answer.
    expect(shouldAutoSaveMemory({ memoryConfig: { autoSave: true } } as any, { endUserId: 'eu-1' } as any)).toBe(false);
  });

  it('saves a visitor run only when the product opted its visitors in', () => {
    const agent = { memoryConfig: { autoSave: true } } as any;
    expect(shouldAutoSaveMemory(agent, { endUserId: 'eu-1', metadata: { visitorMemory: true } } as any)).toBe(true);
    expect(shouldAutoSaveMemory(agent, { endUserId: 'eu-1', metadata: { visitorMemory: false } } as any)).toBe(false);
    expect(shouldAutoSaveMemory(agent, { endUserId: 'eu-1', metadata: {} } as any)).toBe(false);
  });
});

describe('runMayWriteSharedMemory on an app place with no end-user row', () => {
  it('keeps a widget, channel or A2A visitor out of shared memory unless the app opted them in', () => {
    // These runs have no endUserId; before the appVisitor mark they read as
    // an operator's own run and wrote shared memory regardless of the app.
    expect(runMayWriteSharedMemory({ endUserId: null, metadata: { appVisitor: true, visitorMemory: false } } as any)).toBe(false);
    expect(runMayWriteSharedMemory({ endUserId: null, metadata: { appVisitor: true } } as any)).toBe(false);
    expect(runMayWriteSharedMemory({ endUserId: null, metadata: { appVisitor: true, visitorMemory: true } } as any)).toBe(true);
  });

  it('still lets an operator run write it', () => {
    expect(runMayWriteSharedMemory({ endUserId: null, metadata: { channelUserId: 'U1' } } as any)).toBe(true);
  });
});
