import { Module, Global } from '@nestjs/common';
import { PluginManagerService } from './plugin-manager.service';

@Global()
@Module({
  providers: [PluginManagerService],
  exports: [PluginManagerService],
})
export class PluginsModule {}