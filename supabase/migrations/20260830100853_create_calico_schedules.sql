create table public.calico_schedules (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.calico_schedules enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update on table public.calico_schedules to authenticated;

create policy "Users can read their own Calico schedule"
on public.calico_schedules
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own Calico schedule"
on public.calico_schedules
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own Calico schedule"
on public.calico_schedules
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create function public.get_calico_schedule()
returns table (
  state jsonb,
  revision bigint,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select schedule.state, schedule.revision, schedule.updated_at
  from public.calico_schedules as schedule
  where schedule.user_id = (select auth.uid());
$$;

create function public.save_calico_schedule(
  expected_revision bigint,
  next_state jsonb
)
returns table (
  state jsonb,
  revision bigint,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'An authenticated user is required';
  end if;

  if expected_revision = 0 then
    return query
      insert into public.calico_schedules as schedule (user_id, state)
      values (current_user_id, next_state)
      on conflict (user_id) do nothing
      returning schedule.state, schedule.revision, schedule.updated_at;
    return;
  end if;

  return query
    update public.calico_schedules as schedule
    set state = next_state,
        revision = schedule.revision + 1,
        updated_at = timezone('utc', now())
    where schedule.user_id = current_user_id
      and schedule.revision = expected_revision
    returning schedule.state, schedule.revision, schedule.updated_at;
end;
$$;

revoke all on function public.get_calico_schedule() from public;
revoke all on function public.save_calico_schedule(bigint, jsonb) from public;
grant execute on function public.get_calico_schedule() to authenticated;
grant execute on function public.save_calico_schedule(bigint, jsonb) to authenticated;
