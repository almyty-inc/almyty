import { FilesService } from '../files.service';
import { AgentFile } from '../../../entities/file.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * GET /files is open to every viewer of the org and pages up to 100 rows.
 * It used to return each file's `extractedText` -- the full text of every
 * uploaded document -- in the list. The list names files; the text is
 * served by GET /files/:id only.
 */
describe('file list', () => {
  const seed = [
    { id: 'f1', organizationId: 'org-1', agentId: 'a1', name: 'contract.pdf', mimeType: 'application/pdf', size: 10, storageKey: 'k1', extractedText: 'CONFIDENTIAL salary table', createdAt: new Date('2026-09-01') },
    { id: 'f2', organizationId: 'org-1', agentId: 'a2', name: 'notes.txt', mimeType: 'text/plain', size: 5, storageKey: 'k2', extractedText: 'private notes', createdAt: new Date('2026-09-02') },
    { id: 'f3', organizationId: 'org-2', agentId: 'a1', name: 'other.txt', mimeType: 'text/plain', size: 5, storageKey: 'k3', extractedText: 'other tenant', createdAt: new Date('2026-09-03') },
  ];

  const build = () => {
    const repo = fakeRepository<AgentFile>({ make: () => new AgentFile(), seed: seed as any });
    return new FilesService(repo as any, {} as any, {} as any, { log: jest.fn() } as any);
  };

  it('lists the organization files without their extracted text', async () => {
    const result = await build().findAll('org-1');

    expect(result.data.map((f) => f.id)).toEqual(['f2', 'f1']);
    expect(result.total).toBe(2);
    for (const file of result.data) expect(file).not.toHaveProperty('extractedText');
    expect(JSON.stringify(result)).not.toContain('salary');
  });

  it('keeps the filters', async () => {
    const result = await build().findAll('org-1', { agentId: 'a1' });
    expect(result.data.map((f) => f.id)).toEqual(['f1']);
  });

  it('the detail read still carries the extracted text', async () => {
    const file = await build().findById('f1', 'org-1');
    expect(file.extractedText).toBe('CONFIDENTIAL salary table');
  });
});
