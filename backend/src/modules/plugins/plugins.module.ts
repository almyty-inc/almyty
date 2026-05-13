import { Module, Global } from '@nestjs/common';
import { PluginManagerService } from './plugin-manager.service';
import { PluginStoreHelper } from './plugin-store.helper';

@Global()
@Module({
  providers: [PluginManagerService, PluginStoreHelper],
  exports: [PluginManagerService],
})
export class PluginsModule {}