import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';

import { ConnectionsGovernanceController } from '../connections-governance.controller';

/** Credentials governance lives under the same name as the credentials it governs. */
describe('credentials governance routes', () => {
  it('are under /ee/credentials', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ConnectionsGovernanceController)).toBe('ee/credentials');
  });
});
