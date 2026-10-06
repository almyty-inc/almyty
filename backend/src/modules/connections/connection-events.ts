import { EventEmitter } from 'events';

/**
 * The smallest event bus for connection state (docs/always-on.md, "Wake
 * sources"): published at exactly the places that notify people about a
 * connection (credentials governance's expiry and rotation sweeps), and read
 * by Always on, which wakes the agents that hold a grant on the connection
 * and asked to be woken by that event.
 *
 * In-process on purpose: the sweep that publishes runs on one worker, and a
 * wake is written to the database and the queue from there, so every pod
 * sees the result. Nothing secret travels on it, only the connection's id,
 * name and what happened.
 */
export type ConnectionEventKind = 'expiring' | 'expired' | 'rotation_due';

export interface ConnectionEvent {
  organizationId: string;
  connectionId: string;
  name?: string;
  event: ConnectionEventKind;
}

const bus = new EventEmitter();
bus.setMaxListeners(20);

const NOTIFICATION_TO_EVENT: Record<string, ConnectionEventKind> = {
  'connections.expiring': 'expiring',
  'connections.expired': 'expired',
  'connections.rotation_due': 'rotation_due',
};

/** Publish a connection event. Never throws: a listener's failure is the listener's. */
export function publishConnectionEvent(event: ConnectionEvent): void {
  try {
    bus.emit('connection', event);
  } catch {
    /* a listener threw synchronously; the publisher carries on */
  }
}

/**
 * Publish the event a `connections.*` notification stands for, if it stands
 * for one. Called where those notifications are made.
 */
export function publishForNotification(
  type: string,
  connection: { id: string; organizationId: string; name?: string | null },
): void {
  const event = NOTIFICATION_TO_EVENT[type];
  if (!event) return;
  publishConnectionEvent({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    name: connection.name ?? undefined,
    event,
  });
}

/** Listen for connection events. Returns the function that stops listening. */
export function onConnectionEvent(listener: (event: ConnectionEvent) => void): () => void {
  bus.on('connection', listener);
  return () => bus.off('connection', listener);
}
