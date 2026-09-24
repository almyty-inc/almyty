import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ToolsController } from '../tools.controller';
import { PrivateToolGuard } from '../../../common/authorization/private-resource.guard';

/**
 * A tool's own usage numbers (`GET .../tools/:toolId/stats`) must answer
 * another member's private tool as not found. That is PrivateToolGuard's
 * job, applied at the controller class so every `:toolId` route gets it;
 * this pins the wiring so moving the stats route or the guard cannot
 * quietly drop it. (The tool's request log rows are filtered in
 * AnalyticsService.getRequestLogs.)
 */
describe('tool stats route is behind PrivateToolGuard', () => {
  it('guards the whole ToolsController with PrivateToolGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ToolsController) ?? [];
    expect(guards).toContain(PrivateToolGuard);
  });

  it('names the tool in the :toolId param the guard checks', () => {
    const path = Reflect.getMetadata(PATH_METADATA, ToolsController.prototype.getToolStats);
    expect(path).toBe(':toolId/stats');
  });
});
