/**
 * Stand-in for the `approval_policy_approvals` table.
 *
 * It enforces the unique (requestId, approverId) index, because the
 * service relies on the database to refuse a repeat approver — a fake
 * that accepted every insert would let the double-count bug back in
 * without a single test going red.
 */
export class FakePolicyApprovalsRepo {
  rows: Array<{ requestId: string; approverId: string; roles: string[]; createdAt: Date }> = [];
  private seq = 0;

  async insert(row: {
    requestId: string;
    organizationId: string;
    approverId: string;
    roles: string[];
  }) {
    if (this.rows.some((r) => r.requestId === row.requestId && r.approverId === row.approverId)) {
      const err: any = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    }
    this.rows.push({
      requestId: row.requestId,
      approverId: row.approverId,
      roles: row.roles,
      createdAt: new Date(1_700_000_000_000 + this.seq++),
    });
    return { identifiers: [] };
  }

  async find({ where }: any) {
    return this.rows
      .filter((r) => r.requestId === where.requestId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}
