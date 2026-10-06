import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentFile } from '../../entities/file.entity';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { StorageService } from './storage.service';
import { TextExtractorService } from './text-extractor.service';

@Module({
  imports: [TypeOrmModule.forFeature([AgentFile])],
  providers: [FilesService, StorageService, TextExtractorService],
  controllers: [FilesController],
  // TextExtractorService: a channel describes a file someone sent with it (gateways/channels/channel-attachments.service.ts).
  exports: [FilesService, StorageService, TextExtractorService],
})
export class FilesModule {}
