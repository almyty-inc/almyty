import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Memory } from '../../entities/memory.entity';
import { Organization } from '../../entities/organization.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';
import { EmbeddingService } from './embedding.service';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Memory, Organization, LlmProvider]),
    forwardRef(() => LlmProvidersModule),
  ],
  providers: [MemoryService, EmbeddingService],
  controllers: [MemoryController],
  exports: [MemoryService, EmbeddingService],
})
export class MemoryModule {}
