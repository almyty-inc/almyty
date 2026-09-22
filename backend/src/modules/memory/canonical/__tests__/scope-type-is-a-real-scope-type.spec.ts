import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';

import { CanonicalMemoryController } from '../canonical-memory.controller';
import { SCOPE_TYPE_VALUES } from '../canonical.types';

/**
 * `ownScope` used to default a missing `scope_type` to `'org' as
 * ScopeType` -- a cast over a value that is not a member of ScopeType at
 * all. Most routes pre-check `scope_type` and never reached it, but two
 * do not:
 *
 *   POST /memory/canonical/transfer        (only source/target checked)
 *   POST /memory/canonical/document/import (only source_uri/content)
 *
 * so a client that omitted scope_type made `transfer` filter on
 * `scope_type = 'org'`, match nothing, and report a successful migration
 * of zero items -- a cross-backend migration that silently did nothing
 * and said it worked -- while `document/import` built rows the
 * `scope_type IN ('user','workspace','project','collab')` CHECK
 * constraint rejects, surfacing as a raw 500.
 */
describe('canonical memory scope_type is always a real ScopeType', () => {
  const req = { user: { id: 'u-1', sub: 'u-1', currentOrganizationId: 'org-1' } };

  function controller(): any {
    return new CanonicalMemoryController(
      {} as any, {} as any, {} as any, {} as any, {} as any,
    );
  }

  function ownScope(scope: any) {
    return (controller() as any).ownScope(req, scope);
  }

  it('never yields a scope_type outside SCOPE_TYPE_VALUES', () => {
    for (const scopeType of SCOPE_TYPE_VALUES) {
      const scope = ownScope({ scope_type: scopeType, scope_id: 'org-1' });
      expect(SCOPE_TYPE_VALUES).toContain(scope.scope_type);
      expect(scope.scope_id).toBe('org-1');
    }
  });

  it('refuses a missing scope_type instead of inventing one', () => {
    expect(() => ownScope({ scope_id: 'org-1' })).toThrow(HttpException);
    try {
      ownScope({ scope_id: 'org-1' });
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err.getResponse().error).toBe('BAD_REQUEST');
    }
  });

  it('refuses an undefined scope object', () => {
    expect(() => ownScope(undefined)).toThrow(HttpException);
  });

  it('refuses a scope_type that is not one of the four', () => {
    // 'org' is the exact value the old fallback produced.
    for (const bad of ['org', 'organization', 'agent', '']) {
      expect(() => ownScope({ scope_type: bad, scope_id: 'org-1' })).toThrow(HttpException);
    }
  });

  it('still refuses another tenant scope_id before looking at scope_type', () => {
    expect(() =>
      ownScope({ scope_type: 'workspace', scope_id: 'org-2' }),
    ).toThrow(HttpException);
    try {
      ownScope({ scope_type: 'workspace', scope_id: 'org-2' });
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(err.getResponse().error).toBe('SCOPE_FORBIDDEN');
    }
  });

  it('the transfer route reaches ownScope with no scope_type pre-check of its own', async () => {
    const transfer = jest.fn();
    const ctrl: any = new CanonicalMemoryController(
      {} as any, { transfer } as any, {} as any, {} as any, {} as any,
    );

    await expect(
      ctrl.transfer({ source: 'a', target: 'b' } as any, req),
    ).rejects.toThrow(HttpException);
    // The point: the router was never asked to move anything.
    expect(transfer).not.toHaveBeenCalled();
  });

  it('the document/import route refuses before writing unreachable rows', async () => {
    const importSource = jest.fn();
    const ctrl: any = new CanonicalMemoryController(
      {} as any, {} as any, { importSource } as any, {} as any, {} as any,
    );

    await expect(
      ctrl.importDocument({ source_uri: 'https://x/y', content: 'hello' } as any, req),
    ).rejects.toThrow(HttpException);
    expect(importSource).not.toHaveBeenCalled();
  });
});
