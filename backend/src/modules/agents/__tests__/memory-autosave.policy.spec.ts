import { runMayWriteSharedMemory } from '../memory-autosave.policy';

describe('runMayWriteSharedMemory for a visitor with an end-user row', () => {
  it('keeps a hosted-chat or widget visitor out of memory unless the product opted them in', () => {
    // Memory is read back into later runs; a visitor's words must not
    // become part of someone else's answer.
    expect(runMayWriteSharedMemory({ endUserId: 'eu-1' } as any)).toBe(false);
    expect(runMayWriteSharedMemory({ endUserId: 'eu-1', metadata: { visitorMemory: false } } as any)).toBe(false);
    expect(runMayWriteSharedMemory({ endUserId: 'eu-1', metadata: { visitorMemory: true } } as any)).toBe(true);
  });

  it("lets an operator's own run write it", () => {
    expect(runMayWriteSharedMemory({ endUserId: null } as any)).toBe(true);
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
