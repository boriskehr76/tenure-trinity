-- Baseline migration: captured from live project fvrdluiodycckqdufbqj on 2026-06-11.
-- This reflects schema that already exists in production. It is recorded here so the
-- repo is the source of truth going forward. Marked as applied remotely — do not
-- re-run against the live database.

-- ============================================================
-- profiles
-- ============================================================
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  email text,
  availability_state text default 'actively_looking',
  cv_text text,

  axis_structure_min double precision,
  axis_structure_baseline double precision,
  axis_structure_max double precision,
  axis_collaboration_min double precision,
  axis_collaboration_baseline double precision,
  axis_collaboration_max double precision,
  axis_feedback_min double precision,
  axis_feedback_baseline double precision,
  axis_feedback_max double precision,
  axis_pace_min double precision,
  axis_pace_baseline double precision,
  axis_pace_max double precision,
  axis_leadership_min double precision,
  axis_leadership_baseline double precision,
  axis_leadership_max double precision,

  profile_summary text,
  profile_last_updated timestamptz,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Users read own profile" on profiles
  for select using (auth.uid() = id);

create policy "Users update own profile" on profiles
  for update using (auth.uid() = id);

-- ============================================================
-- applications
-- ============================================================
create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  company_name text not null,
  role_title text not null,
  channel text,
  applied_date date,
  salary_range text,
  contact_name text,
  why_interested text,
  notes text,
  job_url text,
  job_description_text text,
  match_pct integer,
  analysis_summary text,
  analysis_requirements text,
  analysis_interview_questions text,
  analysis_honest_flag text,
  current_stage text not null default 'researching',
  status_flag text default 'active',
  close_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  applied_at timestamptz,
  last_activity_at timestamptz default now()
);

alter table applications enable row level security;

create policy "Users manage own applications" on applications
  for all using (auth.uid() = user_id);

-- ============================================================
-- stage_history
-- ============================================================
create table stage_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  from_stage text,
  to_stage text not null,
  moved_at timestamptz default now()
);

alter table stage_history enable row level security;

create policy "Users read own stage history" on stage_history
  for select using (auth.uid() = user_id);

create policy "Users insert own stage history" on stage_history
  for insert with check (auth.uid() = user_id);

-- ============================================================
-- conversations
-- ============================================================
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  job_id uuid references applications (id) on delete set null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  input_mode text default 'text',
  created_at timestamptz default now()
);

alter table conversations enable row level security;

create policy "Users manage own conversations" on conversations
  for all using (auth.uid() = user_id);

-- ============================================================
-- functions + triggers
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$
begin
  insert into profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        name = excluded.name;
  return new;
exception
  when others then
    return new;
end;
$function$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create trigger applications_updated_at
  before update on applications
  for each row execute function public.update_updated_at();

create or replace function public.record_stage_change()
returns trigger
language plpgsql
as $function$
begin
  if old.current_stage is distinct from new.current_stage then
    insert into stage_history (application_id, user_id, from_stage, to_stage)
    values (new.id, new.user_id, old.current_stage, new.current_stage);
    new.last_activity_at = now();
  end if;
  return new;
end;
$function$;

create trigger on_stage_change
  before update on applications
  for each row execute function public.record_stage_change();
