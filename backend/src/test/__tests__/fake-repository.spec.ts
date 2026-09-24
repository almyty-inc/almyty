import { In, IsNull, LessThan, MoreThanOrEqual, Not, Raw } from 'typeorm';

import { fakeRepository, UnmodelledQueryError } from '../fake-repository';

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
});
