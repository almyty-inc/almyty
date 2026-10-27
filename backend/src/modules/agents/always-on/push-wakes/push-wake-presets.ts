import type { PushWakePreset } from './push-wake.types';

/**
 * The push wakes almyty knows how to set up, as data (like the connector
 * catalog). Each fills the generic fields of push-wake.types.ts; nothing
 * in the code reads a preset's key. Facts checked against Google's own
 * documentation on 2026-10-22:
 *
 * Google Calendar (developers.google.com/workspace/calendar/api/guides/push):
 * `events.watch` registers a channel { id, type: "web_hook", address,
 * token }; Google echoes the token in X-Goog-Channel-Token on every push,
 * sends X-Goog-Channel-ID and X-Goog-Resource-State ("sync" once when the
 * channel opens, then "exists" / "not_exists"). The answer's `expiration`
 * is milliseconds since 1970; channels are not renewed in place, so a new
 * one is opened before the old ends and the old one stopped with
 * `channels.stop` { id, resourceId }. What changed comes from
 * `events.list` with `syncToken`; a 410 means the token is too old and a
 * full list starts again.
 *
 * Gmail (developers.google.com/workspace/gmail/api/guides/push):
 * `users.watch` { topicName, labelIds } publishes to the person's own
 * Cloud Pub/Sub topic (gmail-api-push@system.gserviceaccount.com needs
 * Pub/Sub Publisher on it); the answer carries `historyId` and
 * `expiration`, and the watch has to be renewed at least every 7 days
 * (Google recommends daily). A Pub/Sub push subscription with
 * authentication sends `Authorization: Bearer <OIDC token>` signed by
 * Google (iss accounts.google.com, aud as configured, email the push
 * service account, keys at https://www.googleapis.com/oauth2/v3/certs).
 * What changed comes from `users.history.list` from the stored historyId;
 * a 404 means it is too old and the cursor starts again from
 * `users.getProfile`.
 */
export const PUSH_WAKE_PRESETS: PushWakePreset[] = [
  {
    key: 'google_calendar',
    name: 'Google Calendar',
    description: 'When something changes in Google Calendar',
    operations: ['calendar.events.watch', 'calendar.events.list', 'calendar.channels.stop'],
    apiHint: 'Connect Google Calendar under APIs first (see Connect Google).',
    fields: [
      {
        key: 'calendarId',
        label: 'Calendar',
        placeholder: 'primary',
        default: 'primary',
        help: '"primary" is the main calendar of the account you signed in with; another calendar\'s ID is under its Settings → Integrate calendar.',
      },
    ],
    setup: [
      {
        text: 'Nothing to set up in Google Cloud: almyty opens a notification channel on the calendar with your Google Calendar sign-in, and renews it before Google closes it.',
      },
      {
        text: 'Google sends notifications only to a public HTTPS address. This is the one almyty gives it:',
        command: '{{endpoint.url}}',
      },
    ],
    spec: {
      verification: { method: 'shared_token', headerName: 'x-goog-channel-token', generated: true },
      checks: [
        { header: 'x-goog-channel-id', oneOf: ['{{state.subscription.id}}'] },
        { header: 'x-goog-resource-state', oneOf: ['sync', 'exists', 'not_exists'] },
      ],
      ignore: [{ header: 'x-goog-resource-state', oneOf: ['sync'] }],
      subscribe: {
        operation: 'calendar.events.watch',
        arguments: {
          path: { calendarId: '{{settings.calendarId}}' },
          body: { id: '{{uuid}}', type: 'web_hook', address: '{{endpoint.url}}', token: '{{secret}}' },
        },
        expiresAtPath: 'expiration',
        keep: { id: 'id', resourceId: 'resourceId' },
      },
      renew: { beforeExpiryMinutes: 180, stopPrevious: true },
      stop: {
        operation: 'calendar.channels.stop',
        arguments: { body: { id: '{{state.subscription.id}}', resourceId: '{{state.subscription.resourceId}}' } },
      },
      changes: {
        operation: 'calendar.events.list',
        arguments: {
          path: { calendarId: '{{settings.calendarId}}' },
          query: { syncToken: '{{state.cursor}}', pageToken: '{{page}}', showDeleted: true, maxResults: 250 },
        },
        nextPagePath: 'nextPageToken',
        maxPages: 10,
        itemsPath: 'items[*]',
        cursorPath: 'nextSyncToken',
        resetOnStatus: [410],
        prime: {
          operation: 'calendar.events.list',
          arguments: {
            path: { calendarId: '{{settings.calendarId}}' },
            query: { pageToken: '{{page}}', showDeleted: true, maxResults: 2500 },
          },
          nextPagePath: 'nextPageToken',
          maxPages: 50,
          cursorPath: 'nextSyncToken',
        },
        item: { id: 'id', summary: 'summary', status: 'status', start: 'start.dateTime', startDate: 'start.date', end: 'end.dateTime', updated: 'updated' },
        maxItems: 20,
      },
      summary: '{{count}} change(s) in Google Calendar, latest "{{last.summary}}"',
      resourceKey: '{{settings.calendarId}}',
    },
    debounceSeconds: 10,
  },
  {
    key: 'gmail',
    name: 'Gmail',
    description: 'When a new email arrives in Gmail',
    operations: ['gmail.users.watch', 'gmail.users.history.list', 'gmail.users.stop', 'gmail.users.getProfile', 'gmail.users.messages.get'],
    apiHint: 'Connect Gmail under APIs first (see Connect Google).',
    fields: [
      {
        key: 'topicName',
        label: 'Pub/Sub topic',
        placeholder: 'projects/my-project/topics/almyty-gmail',
        required: true,
        pattern: '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/topics/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$',
        help: 'The full name of the topic you create in step 1.',
      },
      {
        key: 'pushServiceAccount',
        label: 'Push service account',
        placeholder: 'almyty-push@my-project.iam.gserviceaccount.com',
        required: true,
        pattern: '^[^@\\s]+@[^@\\s]+\\.iam\\.gserviceaccount\\.com$',
        help: 'The service account the push subscription signs its calls with (step 3). Only calls signed for it wake the agent.',
      },
      { key: 'labelId', label: 'Label', placeholder: 'INBOX', default: 'INBOX', help: 'Only mail that gets this label wakes it.' },
    ],
    setup: [
      {
        text: 'Create a Pub/Sub topic in the Google Cloud project your Gmail sign-in uses (enable the Cloud Pub/Sub API there first).',
        consolePath: 'Google Cloud console → Pub/Sub → Topics → Create topic',
        command: 'gcloud pubsub topics create almyty-gmail',
      },
      {
        text: 'Let Gmail publish to it: add gmail-api-push@system.gserviceaccount.com with the role Pub/Sub Publisher.',
        consolePath: 'Pub/Sub → Topics → almyty-gmail → Permissions (Show info panel) → Add principal',
        command:
          'gcloud pubsub topics add-iam-policy-binding almyty-gmail --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher',
      },
      {
        text: 'Create a service account for the push calls. It needs no roles; Google signs each call with it, and almyty checks the signature.',
        consolePath: 'IAM & Admin → Service Accounts → Create service account',
        command: 'gcloud iam service-accounts create almyty-push --display-name="almyty push"',
      },
      {
        text: 'Create a push subscription that sends to almyty with authentication on: the service account from step 3, and this address as both the endpoint and the audience.',
        consolePath:
          'Pub/Sub → Subscriptions → Create subscription → Delivery type: Push → Endpoint URL, Enable authentication, Service account, Audience',
        command:
          'gcloud pubsub subscriptions create almyty-gmail-push --topic=almyty-gmail --push-endpoint="{{endpoint.url}}" --push-auth-service-account="{{settings.pushServiceAccount}}" --push-auth-token-audience="{{endpoint.url}}"',
      },
      {
        text: 'Fill in the topic and the service account below and save. almyty then starts the Gmail watch with your Gmail sign-in and renews it every day.',
      },
    ],
    spec: {
      verification: {
        method: 'oidc_jwt',
        issuers: ['https://accounts.google.com', 'accounts.google.com'],
        jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
        audience: '{{endpoint.url}}',
        claims: { email: '{{settings.pushServiceAccount}}', email_verified: 'true' },
      },
      subscribe: {
        operation: 'gmail.users.watch',
        arguments: {
          path: { userId: 'me' },
          body: { topicName: '{{settings.topicName}}', labelIds: ['{{settings.labelId}}'], labelFilterBehavior: 'INCLUDE' },
        },
        expiresAtPath: 'expiration',
        cursorPath: 'historyId',
      },
      renew: { everyMinutes: 1440 },
      stop: { operation: 'gmail.users.stop', arguments: { path: { userId: 'me' } } },
      changes: {
        operation: 'gmail.users.history.list',
        arguments: {
          path: { userId: 'me' },
          query: { startHistoryId: '{{state.cursor}}', historyTypes: 'messageAdded', labelId: '{{settings.labelId}}', pageToken: '{{page}}' },
        },
        nextPagePath: 'nextPageToken',
        maxPages: 10,
        itemsPath: 'history[*].messagesAdded[*].message',
        cursorPath: 'historyId',
        resetOnStatus: [404],
        prime: { operation: 'gmail.users.getProfile', arguments: { path: { userId: 'me' } }, cursorPath: 'historyId' },
        item: { id: 'id', threadId: 'threadId' },
        detail: {
          operation: 'gmail.users.messages.get',
          arguments: { path: { userId: 'me', id: '{{item.id}}' }, query: { format: 'metadata' } },
          fields: {
            from: 'payload.headers[name=From].value',
            subject: 'payload.headers[name=Subject].value',
            date: 'payload.headers[name=Date].value',
          },
        },
        maxItems: 20,
        maxDetails: 10,
      },
      summary: '{{count}} new email(s) in Gmail, latest from {{last.from}}: "{{last.subject}}"',
      // Gmail keeps one watch per mailbox: every agent on this connection shares it.
      resourceKey: 'mailbox',
    },
    debounceSeconds: 10,
  },
];

export function pushWakePreset(key: string | null | undefined): PushWakePreset | null {
  return PUSH_WAKE_PRESETS.find((p) => p.key === key) ?? null;
}
