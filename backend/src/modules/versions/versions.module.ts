import { Module } from '@nestjs/common';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';

@Module({
  providers: [VersionsService],
  controllers: [VersionsController],
  exports: [VersionsService],
})
export class VersionsModule {}
