# Calico persistence and recovery

Calico is local-first. Each browser saves its working copy in local storage immediately, and signed-in users also have one private schedule in Supabase for cross-device continuity.

## Product boundary

- Email magic links provide the first sign-in method. The browser uses Supabase's publishable key only; no administrative key is present in the client or repository.
- Every account owns a single `public.calico_schedules` row, keyed by `auth.users.id`.
- Row-level security permits an authenticated person to read, create, and update only their own row.
- `get_calico_schedule()` and `save_calico_schedule()` provide the client API. A save requires the expected revision and returns no row when another device has changed the schedule first.
- The browser keeps its local copy when a network or account operation fails. It never silently overwrites a newer account copy.

## Scheduling state

State version 6 includes local, syncable scheduling preferences:

- `dailyWorkingHours[YYYY-MM-DD]` overrides default working start, end, and maximum task hours for one date.
- Events can be marked as `availability` blocks. They recur using the same repeat rules as events and reduce available planning time.
- Task occurrence overrides may include `timeBlocks[YYYY-MM-DD]` with a `preferred` or `fixed` start/end time. A time block also locks its requested hours to that date so the scheduler cannot silently move it to another day.

Existing day-level task pins remain valid. Invalid or malformed new fields are discarded during normalization rather than being allowed into the scheduler.

## Sync behaviour

1. Local changes save first.
2. Once an email session is ready, Calico debounces an account save for 600ms.
3. A new account receives the existing local schedule. If both copies exist, the user chooses whether to use the account copy or replace it with the device copy.
4. A stale revision pauses sync and tells the user that another device changed the schedule. It does not use last-write-wins.
5. Signing out removes the session from that browser but leaves its local schedule intact.

Account metadata such as the email address, revision, and sync error are not sent to the account record and are not included in exported backups. Version 6 also clears credentials left by the retired generic HTTPS endpoint adapter.

## Recovery and future work

- Exported JSON backups stay portable and can be imported before making any account-choice decision.
- Backup import uses the same defensive normalization path and will sync as the next account update.
- Calico does not yet retain server-side history or expose a full conflict-resolution screen. The initial stale-write protection intentionally stops instead of guessing which version should win.
- Google sign-in, calendar imports, notifications, shared planning, and richer conflict choices remain later product work.
