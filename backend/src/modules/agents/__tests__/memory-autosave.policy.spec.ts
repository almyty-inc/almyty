import { shouldAutoSaveMemory } from '../memory-autosave.policy';

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
});
