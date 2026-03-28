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
  exports: [FilesService, StorageService],
})
export class FilesModule {}
