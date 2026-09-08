import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModelRegistryService } from './model-registry.service';

@Module({
  imports: [ConfigModule],
  providers: [ModelRegistryService],
  exports: [ModelRegistryService],
})
export class ModelRegistryModule {}
