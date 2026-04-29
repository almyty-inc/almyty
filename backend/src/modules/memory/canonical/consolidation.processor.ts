import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { ConsolidationService } from './consolidation.service';

export const CONSOLIDATION_QUEUE_NAME = 'canonical-memory-consolidation';

/**
 * Consolidation processor. Runs on a repeating schedule (configured
 * in the module's onApplicationBootstrap) and, for every workspace
 * scope that has consolidation enabled, runs the LLM-driven
 * extract-and-supersede pass.
 */
@Processor(CONSOLIDATION_QUEUE_NAME)
export class CanonicalMemoryConsolidationProcessor {
  private readonly logger = new Logger(CanonicalMemoryConsolidationProcessor.name);

  constructor(private readonly consolidation: ConsolidationService) {}

  @Process('consolidate-all')
  async handle(_job: Job): Promise<{ runs: number }> {
    const results = await this.consolidation.runAllEnabled();
    const did = results.filter((r) => !r.skipped).length;
    if (did > 0) {
      this.logger.log(
        `consolidation pass: ran ${did}/${results.length} scopes; ` +
          `total facts written=${results.reduce((s, r) => s + r.consolidated_facts, 0)}`,
      );
    }
    return { runs: did };
  }
}
