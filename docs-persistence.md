# Calico persistence and recovery

Calico is local-first. It also has an optional HTTPS cloud-state adapter, which is deliberately separate from a future Calico account service.

## Current product boundary

- The browser keeps the authoritative working copy in local storage and can export/import a portable backup.
- The optional adapter can sync one authenticated JSON document when an endpoint and access token are supplied.
- Calico does not yet provide sign-up, sign-in, managed user identities, a hosted database, or server-side conflict resolution. Those require a deployed service owned by the product, not a browser-only patch.

## Scheduling state

State version 5 adds local, syncable scheduling preferences:

- `dailyWorkingHours[YYYY-MM-DD]` overrides default working start, end, and maximum task hours for one date.
- Events can be marked as `availability` blocks. They recur using the same repeat rules as events and reduce available planning time.
- Task occurrence overrides may include `timeBlocks[YYYY-MM-DD]` with a `preferred` or `fixed` start/end time. A time block also locks its requested hours to that date so the scheduler cannot silently move it to another day.

Existing day-level task pins remain valid. Invalid or malformed new fields are discarded during normalization rather than being allowed into the scheduler.

## Cloud API contract

Configure an authenticated state endpoint in Settings → Account & Cloud Sync.

- `GET <endpoint>` returns either a Calico state object or `{ "state": { ... } }`.
- `PUT <endpoint>` accepts `{ "state": { ... }, "updatedAt": "..." }`.
- The browser sends `Authorization: Bearer <token>` when a token is configured.

This keeps infrastructure minimal: any small authenticated JSON document store can back the endpoint, while Google/Outlook/iCloud/calendar integrations remain out of scope for v0.1.

## Requirements for real account sync

A production cross-device account implementation must add all of the following before this adapter is presented as Calico sign-in:

- An authentication provider and a stable user identifier.
- A database record owned by that user, enforced server-side.
- A server-issued document revision (or equivalent optimistic concurrency token).
- Conditional writes that reject stale revisions with `409 Conflict`, never last-write-wins silently.
- A client conflict screen that can keep local, keep remote, or export both versions.
- Server-side backup/retention, rate limiting, and audit-safe error logging.

Once a hosting provider and account project are available, the browser adapter should move to `GET`/conditional `PUT` using that revision rather than adding another layer of client-side tokens.

## Safety rules

- Local saves complete before any remote save is attempted.
- Failed remote saves never overwrite the last good local state.
- Malformed remote state is rejected by `normalizeState` and kept out of the active schedule.
- Existing `localStorage` data remains the recovery source and can be exported before or after cloud sync.
- Backup import goes through the same defensive normalization path and can be re-synced to the account.
- Reset still requires confirmation and can be undone during the page session.

## Migration

On first cloud sync, Calico uploads the current local state if no remote state exists. If a valid remote state exists, the user is prompted before replacing the local state so local work is not silently lost.
