import { Mem0Backend } from '../mem0.backend';
import { SupermemoryBackend } from '../supermemory.backend';
import { ZepBackend } from '../zep.backend';

/**
 * A memory listed from an outside service knows the id that service
 * deletes it by. Moving memories out of an account lists them and then
 * deletes each one by nativeId(); a listed memory whose metadata carried
 * almyty's id but not the service's own could be copied but never deleted.
 */
describe('a listed memory carries the id its service deletes it by', () => {
  it('Mem0', () => {
    const b = new Mem0Backend();
    const item = b.toCanonical({ id: 'mem0-1', memory: 'Dana prefers email', metadata: { almyty_id: 'a-1', scope_id: 'org-1' } });
    expect(item.id).toBe('a-1');
    expect(b.nativeId(item)).toBe('mem0-1');
  });

  it('Zep', () => {
    const b = new ZepBackend();
    const item = b.toCanonical({ uuid: 'zep-1', content: 'Dana prefers email', metadata: { almyty_id: 'a-1' } });
    expect(item.id).toBe('a-1');
    expect(b.nativeId(item)).toBe('zep-1');
  });

  it('Supermemory', () => {
    const b = new SupermemoryBackend();
    const item = b.toCanonical({ id: 'sm-1', content: 'Dana prefers email', metadata: { almyty_id: 'a-1' } });
    expect(item.id).toBe('a-1');
    expect(b.nativeId(item)).toBe('sm-1');
  });

  it('keeps the id a put recorded over the raw one', () => {
    const b = new Mem0Backend();
    const item = b.toCanonical({ id: 'raw', memory: 'x', metadata: { mem0_id: 'recorded' } });
    expect(b.nativeId(item)).toBe('recorded');
  });
});
