# Calico v0.1 persistence and recovery

Calico keeps the existing local-first state model and adds an optional HTTPS cloud-state adapter for v0.1 accounts.

## Cloud API contract

Configure an authenticated state endpoint in Settings → Account & Cloud Sync.

- `GET <endpoint>` returns either a Calico state object or `{ "state": { ... } }`.
- `PUT <endpoint>` accepts `{ "state": { ... }, "updatedAt": "..." }`.
- The browser sends `Authorization: Bearer <token>` when a token is configured.

This keeps infrastructure minimal: any small authenticated JSON document store can back the endpoint, while Google/Outlook/iCloud/calendar integrations remain out of scope for v0.1.

## Safety rules

- Local saves complete before any remote save is attempted.
- Failed remote saves never overwrite the last good local state.
- Malformed remote state is rejected by `normalizeState` and kept out of the active schedule.
- Existing `localStorage` data remains the recovery source and can be exported before or after cloud sync.
- Backup import goes through the same defensive normalization path and can be re-synced to the account.
- Reset still requires confirmation and can be undone during the page session.

## Migration

On first cloud sync, Calico uploads the current local state if no remote state exists. If a valid remote state exists, the user is prompted before replacing the local state so local work is not silently lost.
