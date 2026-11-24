import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bull';

import { HostedUsageReportService, UsageReportRun } from './hosted-usage-report.service';
import { hostedUsageReporting } from './hosted-metering.config';

export const HOSTED_USAGE_REPORT_QUEUE = 'hosted-usage-report';
export const RUNNER_USAGE_REPORT_JOB = 'runner-usage-report';
/** A stable id so restarts do not stack schedules and a cron change evicts the old one. */
export const RUNNER_USAGE_REPORT_REPEAT_ID = 'runner-usage-report';

/**
 * Schedules the hourly hosted usage report (HOSTED_USAGE_REPORTING.cron,
 * or `off`), never under NODE_ENV=test. One repeatable Bull job, so with
 * several API pods it runs once an hour, not once per pod.
 */
@Processor(HOSTED_USAGE_REPORT_QUEUE)
export class HostedUsageReportProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(HostedUsageReportProcessor.name);

  constructor(
    @InjectQueue(HOSTED_USAGE_REPORT_QUEUE) private readonly queue: Queue,
    private readonly reports: HostedUsageReportService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { cron } = hostedUsageReporting();
    if (process.env.NODE_ENV === 'test' || !cron) {
      this.logger.log('Hosted usage report not scheduled (NODE_ENV=test or HOSTED_USAGE_REPORTING cron off)');
      return;
    }
    try {
      for (const repeatable of await this.queue.getRepeatableJobs()) {
        if (repeatable.id === RUNNER_USAGE_REPORT_REPEAT_ID && repeatable.cron !== cron) await this.queue.removeRepeatableByKey(repeatable.key);
      }
      await this.queue.add(RUNNER_USAGE_REPORT_JOB, {}, { jobId: RUNNER_USAGE_REPORT_REPEAT_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      this.logger.log(`Hosted usage report scheduled: "${cron}"`);
    } catch (err: any) {
      // Best effort: a Redis hiccup at boot must not take the API down.
      this.logger.error(`Failed to schedule the hosted usage report: ${err?.message ?? err}`);
    }
  }

  @Process(RUNNER_USAGE_REPORT_JOB)
  async handle(): Promise<UsageReportRun> {
    const run = await this.reports.run();
    if (run.rows || run.failed) this.logger.log(`Hosted usage report: ${run.rows} rows, ${run.sent} sent to Stripe, ${run.failed} to retry`);
    return run;
  }
}
