import { In, IsNull, LessThan, MoreThanOrEqual, Not, Raw } from 'typeorm';

import { fakeManager, fakeRepository, UnmodelledQueryError } from '../fake-repository';
import { notOthersPrivateAgent, notOthersPrivateAgentRun, notOthersPrivateTool } from '../../modules/monitoring/private-rows';

/**
 * The fake is only worth using if it can say no, so these pin the ways
 * it says no: the ways the doubles it replaces could not.
 */
describe('fakeRepository', () => {
  class Widget {
    id?: string;
    organizationId!: string;
    status!: string;
    payload?: Record<string, any>;
    count?: number;
    label(): string {
      return `${this.id}:${this.status}`;
    }
  }

  const repo = () =>
    fakeRepository<Widget>({
      make: () => new Widget(),
      seed: [
        { id: 'w1', organizationId: 'org-1', status: 'pending', payload: { n: 1 }, count: 0 },
        { id: 'w2', organizationId: 'org-2', status: 'pending', payload: { n: 2 }, count: 0 },
      ],
    });

  it('a mutation of what save was handed is not a write', async () => {
    const r = repo();
    const w = (await r.findOne({ where: { id: 'w1' } })) as Widget;
    w.status = 'done';
    w.payload!.n = 99;

    expect(r.row('w1')).toMatchObject({ status: 'pending', payload: { n: 1 } });

    await r.save(w);
    expect(r.row('w1')).toMatchObject({ status: 'done', payload: { n: 99 } });
    w.payload!.n = 100;
    expect(r.row('w1')!.payload!.n).toBe(99);
  });

  it('save assigns an id to the entity it was handed and returns that entity', async () => {
    const r = repo();
    const w = r.create({ organizationId: 'org-1', status: 'new' });
    const saved = await r.save(w);
    expect(saved).toBe(w);
    expect(w.id).toBeDefined();
    expect(r.row(w.id!)).toMatchObject({ status: 'new' });
  });

  it('rows come back with their entity prototype', async () => {
    const r = repo();
    const w = (await r.findOne({ where: { id: 'w1' } })) as Widget;
    expect(w).toBeInstanceOf(Widget);
    expect(w.label()).toBe('w1:pending');
  });

  it('findOne evaluates every key of the where', async () => {
    const r = repo();
    await expect(r.findOne({ where: { id: 'w1', organizationId: 'org-2' } })).resolves.toBeNull();
    await expect(r.findOne({ where: { id: 'w1', organizationId: 'org-1' } })).resolves.toMatchObject({ id: 'w1' });
  });

  it('an array where is OR', async () => {
    const r = repo();
    const rows = await r.find({ where: [{ id: 'w1' }, { organizationId: 'org-2' }] });
    expect(rows.map((w: Widget) => w.id).sort()).toEqual(['w1', 'w2']);
  });

  it('update is a compare-and-set: the loser affects nothing', async () => {
    const r = repo();
    await expect(r.update({ id: 'w1', status: 'pending' }, { status: 'done' })).resolves.toMatchObject({ affected: 1 });
    await expect(r.update({ id: 'w1', status: 'pending' }, { status: 'cancelled' })).resolves.toMatchObject({ affected: 0 });
    expect(r.row('w1')!.status).toBe('done');
  });

  it('update and delete honour the organization in their criteria', async () => {
    const r = repo();
    await expect(r.update({ id: 'w2', organizationId: 'org-1' }, { status: 'x' })).resolves.toMatchObject({ affected: 0 });
    await expect(r.delete({ id: 'w2', organizationId: 'org-1' })).resolves.toMatchObject({ affected: 0 });
    expect(r.row('w2')).toMatchObject({ status: 'pending' });
  });

  it('evaluates the operators it models', async () => {
    const r = repo();
    await r.update('w2', { status: 'done', count: 5 });
    expect((await r.find({ where: { status: Not(In(['done'])) } })).map((w: Widget) => w.id)).toEqual(['w1']);
    expect(await r.count({ where: { status: In(['pending', 'done']) } })).toBe(2);
    expect(await r.count({ where: { payload: IsNull() } })).toBe(0);
    expect(await r.count({ where: { count: LessThan(5) } })).toBe(1);
    expect(await r.count({ where: { count: MoreThanOrEqual(5) } })).toBe(1);
  });

  it('refuses null and undefined in a where, as TypeORM does', async () => {
    const r = repo();
    await expect(r.findOne({ where: { organizationId: undefined } })).rejects.toBeInstanceOf(UnmodelledQueryError);
    await expect(r.findOne({ where: { organizationId: null } })).rejects.toBeInstanceOf(UnmodelledQueryError);
    await expect(r.update({ organizationId: undefined } as any, { status: 'x' })).rejects.toBeInstanceOf(
      UnmodelledQueryError,
    );
  });

  it('refuses a criteria shape or operator it does not model instead of matching', async () => {
    const r = repo();
    await expect(r.find({ where: { status: Raw((a) => `${a} = 'pending'`) } })).rejects.toBeInstanceOf(
      UnmodelledQueryError,
    );
    await expect(r.update({}, { status: 'x' })).rejects.toBeInstanceOf(UnmodelledQueryError);
    await expect(r.find({ where: { organization: { id: 'org-1' } } })).rejects.toBeInstanceOf(UnmodelledQueryError);
  });

  it('evaluates a "column + n" update against the stored value', async () => {
    const r = repo();
    await r.update({ id: 'w1' }, { count: () => '"count" + 3' });
    await r.update({ id: 'w1' }, { count: () => '"count" + 3' });
    expect(r.row('w1')!.count).toBe(6);
    await expect(r.update({ id: 'w1' }, { count: () => 'GREATEST(count, 1)' })).rejects.toBeInstanceOf(
      UnmodelledQueryError,
    );
  });

  it('remove deletes the row and clears the id on the entity', async () => {
    const r = repo();
    const w = (await r.findOne({ where: { id: 'w1' } })) as Widget;
    await r.remove(w);
    expect(w.id).toBeUndefined();
    expect(r.row('w1')).toBeUndefined();
  });

  it('find honours order, skip and take', async () => {
    const r = repo();
    const rows = await r.find({ order: { id: 'DESC' }, skip: 0, take: 1 });
    expect(rows.map((w: Widget) => w.id)).toEqual(['w2']);
  });

  describe('Raw: the "not someone else\'s private resource" predicate', () => {
    // The exact predicate PromotedSkillsService filters on, built by the
    // same helper, so a change to the helper's SQL is seen here.
    const notOthersPrivateSource = (viewer: string | null) =>
      Raw((column) => `(${column} IS NULL OR ${notOthersPrivateAgent(column)})`, { privateViewerId: viewer });

    const setup = () => {
      const agents = fakeRepository<any>([
        { id: 'a-private', visibility: 'private', createdBy: 'owner' },
        { id: 'a-org', visibility: 'org', createdBy: 'owner' },
        { id: 'a-ownerless', visibility: 'private', createdBy: null },
      ]);
      const skills = fakeRepository<any>({
        tables: { agents },
        seed: [
          { id: 's-private', organizationId: 'org-1', agentId: 'a-private' },
          { id: 's-org', organizationId: 'org-1', agentId: 'a-org' },
          { id: 's-none', organizationId: 'org-1', agentId: null },
          { id: 's-ownerless', organizationId: 'org-1', agentId: 'a-ownerless' },
          { id: 's-gone', organizationId: 'org-1', agentId: 'a-deleted' },
        ],
      });
      return { agents, skills };
    };
    const ids = async (skills: ReturnType<typeof setup>['skills'], viewer: string | null) =>
      (await skills.find({ where: { agentId: notOthersPrivateSource(viewer) } })).map((s: any) => s.id).sort();

    it('keeps the owner\'s private rows for the owner and drops them for anyone else', async () => {
      const { skills } = setup();
      expect(await ids(skills, 'owner')).toEqual(['s-gone', 's-none', 's-org', 's-private']);
      expect(await ids(skills, 'someone-else')).toEqual(['s-gone', 's-none', 's-org']);
    });

    it('follows Postgres null semantics: a null viewer is not distinct from a null owner', async () => {
      // `NULL IS DISTINCT FROM NULL` is false, so the SQL keeps a private
      // resource with no recorded owner for a caller with no known user.
      // The fake says what Postgres says, not what the code meant.
      const { skills } = setup();
      expect(await ids(skills, null)).toEqual(['s-gone', 's-none', 's-org', 's-ownerless']);
    });

    it('reads the other table at query time', async () => {
      const { agents, skills } = setup();
      await agents.update({ id: 'a-org' }, { visibility: 'private' });
      expect(await ids(skills, 'someone-else')).toEqual(['s-gone', 's-none']);
    });

    it('works through findOne, count and delete criteria too', async () => {
      const { skills } = setup();
      expect(await skills.findOne({ where: { id: 's-private', agentId: notOthersPrivateSource('someone-else') } })).toBeNull();
      expect(await skills.count({ where: { agentId: notOthersPrivateSource('owner') } })).toBe(4);
      expect((await skills.delete({ id: 's-private', agentId: notOthersPrivateSource('someone-else') })).affected).toBe(0);
      expect(skills.row('s-private')).toBeDefined();
    });

    it('throws for any Raw SQL outside the modelled shapes rather than matching', async () => {
      const { agents, skills } = setup();
      const refused = (op: any, repo: any = skills) =>
        expect(repo.find({ where: { agentId: op } })).rejects.toBeInstanceOf(UnmodelledQueryError);

      // The table the predicate reads was not supplied.
      await refused(notOthersPrivateSource('owner'), fakeRepository<any>([{ id: 's', agentId: 'a-org' }]));
      // A bound parameter with no value.
      await refused(Raw((c) => `(${c} IS NULL OR ${notOthersPrivateAgent(c)})`, {}));
      // A near miss of the modelled fragment: dropping the NOT, or flipping the owner test.
      await refused(Raw((c) => notOthersPrivateAgent(c).replace('NOT EXISTS', 'EXISTS'), { privateViewerId: 'owner' }));
      await refused(
        Raw((c) => notOthersPrivateAgent(c).replace('IS DISTINCT FROM', 'IS NOT DISTINCT FROM'), { privateViewerId: 'owner' }),
      );
      // A fragment with a join is not modelled.
      await refused(Raw((c) => notOthersPrivateAgentRun(c), { privateViewerId: 'owner' }));
      // A literal Raw, and an unrelated expression.
      await refused(Raw('a-org'));
      await refused(Raw((c) => `${c} = 'a-org'`));
      expect(agents.find).not.toHaveBeenCalled();
    });

    it('the tool fragment reads the tools table with its own owner column', async () => {
      const tools = fakeRepository<any>([{ id: 't1', visibility: 'private', createdBy: 'owner' }]);
      const execs = fakeRepository<any>({ tables: { tools }, seed: [{ id: 'e1', toolId: 't1' }] });
      const where = (viewer: string | null) => ({ toolId: Raw((c) => notOthersPrivateTool(c), { privateViewerId: viewer }) });
      expect(await execs.count({ where: where('owner') })).toBe(1);
      expect(await execs.count({ where: where('someone-else') })).toBe(0);
      expect(await execs.count({ where: where(null) })).toBe(0);
    });
  });
});

describe('fakeManager', () => {
  class A {}
  class B {}

  it('hands out the registered repositories, in and out of a transaction', async () => {
    const a = fakeRepository<any>([{ id: 'a1' }]);
    const manager = fakeManager([[A, a]]);

    expect((a as any).manager).toBe(manager);
    await manager.transaction(async (m: any) => m.getRepository(A).delete({ id: 'a1' }));
    expect(a.rows()).toHaveLength(0);
  });

  it('refuses an entity it has no repository for', () => {
    const manager = fakeManager([[A, fakeRepository<any>()]]);
    expect(() => manager.getRepository(B)).toThrow(UnmodelledQueryError);
  });
});
