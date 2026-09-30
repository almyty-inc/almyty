import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';

import { MemoryMoveService, MOVE_QUEUE_NAME } from './memory-move.service';

/** Runs one memory move (MemoryMoveService.run), as the member who started or resumed it. */
@Processor(MOVE_QUEUE_NAME)
export class MemoryMoveProcessor {
  constructor(private readonly moves: MemoryMoveService) {}

  @Process('move')
  async handle(job: Job<{ moveId: string; userId: string }>): Promise<{ status: string; moved: number; failed: number }> {
    const move = await this.moves.run(job.data.moveId, job.data.userId);
    return { status: move.status, moved: move.moved, failed: move.failed };
  }
}
