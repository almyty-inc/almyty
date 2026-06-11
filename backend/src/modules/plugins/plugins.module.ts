import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginManagerService } from './plugin-manager.service';
import { PluginStoreHelper } from './plugin-store.helper';
import { UsageMetric } from '../../entities/usage-metric.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([UsageMetric])],
  providers: [PluginManagerService, PluginStoreHelper],
  exports: [PluginManagerService],
})
export class PluginsModule {}