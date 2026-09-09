import { ConnectionsRotatorBridge } from '../connections-rotator.bridge';

describe('ConnectionsRotatorBridge', () => {
  it('answers canRotate from the registry and delegates rotate to the system path', async () => {
    const connections = { rotateAsSystem: jest.fn().mockResolvedValue({ rotated: true }) };
    const registry = { get: jest.fn((key: string) => (key === 'openrouter' ? { capabilities: () => ({ create: true }) } : undefined)) };
    const bridge = new ConnectionsRotatorBridge(connections as any, registry as any);
    expect(bridge.canRotate('openrouter')).toBe(true);
    expect(bridge.canRotate('groq')).toBe(false);
    await expect(bridge.rotate('c-1')).resolves.toEqual({ rotated: true });
    expect(connections.rotateAsSystem).toHaveBeenCalledWith('c-1');
  });
});
