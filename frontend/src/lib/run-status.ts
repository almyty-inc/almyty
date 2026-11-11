// Presentation for every run lifecycle state, from the design-system
// package's run-status.ts. The `satisfies Record<AgentRunStatus, ...>` below
// fails the build when the runtime union in types/runtime.ts gains a state
// with no presentation. `sleeping` is a pause, never a final state.
import type { AgentRunStatus } from '@/types/runtime'
export type RunTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';
export interface RunPresentation { label: string; tone: RunTone; icon: string; terminal: boolean }
const runPresentation = {
  "pending": {
    "label": "Queued",
    "tone": "neutral",
    "icon": "clock",
    "terminal": false
  },
  "running": {
    "label": "Running",
    "tone": "info",
    "icon": "activity",
    "terminal": false
  },
  "waiting_input": {
    "label": "Waiting for input",
    "tone": "warning",
    "icon": "message-circle",
    "terminal": false
  },
  "waiting_approval": {
    "label": "Waiting for approval",
    "tone": "warning",
    "icon": "pause-circle",
    "terminal": false
  },
  "sleeping": {
    "label": "Sleeping",
    "tone": "neutral",
    "icon": "moon",
    "terminal": false
  },
  "completed": {
    "label": "Completed",
    "tone": "success",
    "icon": "circle-check",
    "terminal": true
  },
  "failed": {
    "label": "Failed",
    "tone": "danger",
    "icon": "circle-x",
    "terminal": true
  },
  "cancelled": {
    "label": "Cancelled",
    "tone": "neutral",
    "icon": "circle-slash",
    "terminal": true
  },
  "timeout": {
    "label": "Timed out",
    "tone": "danger",
    "icon": "timer-off",
    "terminal": true
  }
} satisfies Record<AgentRunStatus, RunPresentation>;
export function presentationForRun(status: string): RunPresentation {
  return Object.prototype.hasOwnProperty.call(runPresentation, status)
    ? runPresentation[status as AgentRunStatus]
    : { label: 'Status unavailable', tone: 'neutral', icon: 'circle-help', terminal: false };
}
// A completed lifecycle is not evidence of a successful business outcome.
// If real step evidence reports partial/failed work, show it alongside this
// lifecycle status rather than silently replacing it with success.
