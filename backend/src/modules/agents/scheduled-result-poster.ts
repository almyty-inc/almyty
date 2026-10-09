import type { Agent } from '../../entities/agent.entity';

/**
 * A finished scheduled run, whichever engine ran it: a workflow execution
 * (agent_executions) or an autonomous run (agent_runs). The outcome of
 * posting it is written back onto that row. An always-on agent's daily
 * summary (`digest`, always-on/always-on-digest.ts) is no run: its outcome
 * is not recorded anywhere but the log and, on failure, the owner's
 * notifications.
 */
export interface ScheduledResult {
  kind: 'execution' | 'run' | 'digest';
  id: string;
  status: string;
  output: unknown;
  userId: string | null;
  error?: string | null;
  executionTime?: number;
  totalCost?: number;
  totalTokens?: number;
  metadata?: Record<string, any>;
}

/**
 * Where a scheduled run's result goes, besides the run history.
 *
 * `webhook` is the agent's own webhook URL (which already receives every
 * finished run; naming it here records that this is where the schedule's
 * result is meant to land, and refuses a schedule that names a webhook
 * the agent does not have). `channel` posts the result into one of the
 * agent's own channels -- a Slack channel, a Teams chat, an email address,
 * a phone number -- through that channel's usual send path.
 */
export type ScheduleDelivery = WebhookDelivery | ChannelDelivery;

export interface WebhookDelivery {
  kind: 'webhook';
}

export interface ChannelDelivery {
  kind: 'channel';
  /** The agent channel (agent_channels.id) to post through. */
  channelId: string;
  /**
   * Who or where on that channel: a Slack channel id, a Teams
   * conversation id, email addresses (comma separated), a phone number, a
   * chat id. Empty for a channel that only reaches one place (a Google
   * Chat space webhook, a webhook channel).
   */
  to?: string;
  /** How the destination reads to a person ("#sales", "Chat with Ana"). */
  label?: string;
  /** Extra routing a platform needs and the person never types (Teams serviceUrl). */
  context?: Record<string, string>;
}

/** One place a channel can post to, as the schedule page offers it. */
export interface PostDestination {
  to: string;
  label: string;
  context?: Record<string, string>;
}

/** One of an agent's channels, as the "Send the result to" picker shows it. */
export interface PostChannelOption {
  channelId: string;
  name: string;
  type: string;
  /** False when the channel cannot take a post now; `reason` says why. */
  available: boolean;
  reason?: string;
  /** What a destination is on this platform: "Slack channel", "Phone number". */
  noun: string;
  /**
   * `fixed`: the channel reaches one place and there is nothing to choose.
   * `pick`: choose from `destinations` only. `pick_or_enter`: choose, or type one.
   * `enter`: type it.
   */
  choose: 'fixed' | 'pick' | 'pick_or_enter' | 'enter';
  placeholder?: string;
  hint?: string;
  destinations: PostDestination[];
}

/** What delivering a scheduled result came to, recorded on the run (metadata.channelDelivery). */
export interface ChannelDeliveryOutcome {
  status: 'delivered' | 'failed' | 'skipped';
  channelId: string;
  channelName?: string;
  channelType?: string;
  destination?: string;
  /** How many messages the result went out as (long results are split). */
  parts?: number;
  truncated?: boolean;
  error?: string;
  at: string;
}

/**
 * Posts scheduled results into channels. Implemented in the gateways
 * module (ScheduledPostService), which owns the adapters, and reached from
 * the scheduler by this token so the agents module does not import the
 * gateways module (which already imports it).
 */
export const SCHEDULED_RESULT_POSTER = 'SCHEDULED_RESULT_POSTER';

export interface ScheduledResultPoster {
  /** The agent's channels that can take a post, with where each can reach. */
  destinations(agent: Agent): Promise<PostChannelOption[]>;
  /** Validate a chosen destination and return it in its stored shape. Throws BadRequestException. */
  checkDestination(agent: Agent, delivery: ChannelDelivery): Promise<ChannelDelivery>;
  /** Whether a post may go out now (the channel is live, its spend limit not reached). */
  admit(agent: Agent, delivery: ChannelDelivery): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Post a finished run's result. Never throws; the outcome is recorded on the run. */
  post(
    agent: Agent,
    result: ScheduledResult,
    delivery: ChannelDelivery,
    when?: { timezone?: string },
  ): Promise<ChannelDeliveryOutcome>;
}
