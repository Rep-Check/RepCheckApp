-- RepCheck Supabase schema (brief 5.2)
-- Run this in the Supabase Dashboard → SQL Editor.
--
-- Creates:
--   public.analyses        — one row per completed analysis (history)
--   public.subscriptions   — Pro membership (trial/active)
--   public.usage           — lifetime free-analysis counter (3 total)
--   storage policies on the `videos` bucket (private) — bucket created via
--     the dashboard/API; the RLS policies below make the app the only
--     writer/reader of its own files.

-- ── analyses ────────────────────────────────────────────────────────────
create table if not exists public.analyses (
  id            text primary key,          -- `${Date.now()}` string id
  user_id       uuid not null references auth.users (id) on delete cascade,
  exercise_id   text not null,
  exercise_name text not null,
  score         integer not null,
  grade         text not null,
  risk          text not null,
  cue           text,
  categories    jsonb not null default '[]',
  feedback      jsonb not null default '[]',
  next_focus    text,
  file_name     text,
  frame_count   integer not null default 0,
  engine        text not null default 'server',
  created_at    timestamptz not null default now()
);

create index if not exists analyses_user_created_idx
  on public.analyses (user_id, created_at desc);

alter table public.analyses enable row level security;

create policy "Users read own analyses"
  on public.analyses for select
  using (auth.uid() = user_id);

create policy "Users delete own analyses"
  on public.analyses for delete
  using (auth.uid() = user_id);

-- Inserts happen server-side with the service role (bypasses RLS). Keep a
-- policy so future client-side writes (e.g. fallback saves) work too.
create policy "Users insert own analyses"
  on public.analyses for insert
  with check (auth.uid() = user_id);

-- ── usage (lifetime free-analysis counter: 3 free, then paywall) ──────────
-- One row per user. The app reads it to show "analyses left" and upserts it
-- after every completed analysis.
create table if not exists public.usage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  count   integer not null default 0      -- free analyses used (3 total)
);

alter table public.usage enable row level security;

create policy "Users read own usage"
  on public.usage for select
  using (auth.uid() = user_id);

create policy "Users write own usage"
  on public.usage for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── subscriptions ───────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  plan          text not null default 'pro',
  status        text not null,             -- 'trialing' | 'active'
  started_at    bigint not null,           -- ms epoch
  trial_ends_at bigint
);

alter table public.subscriptions enable row level security;

create policy "Users read own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

create policy "Users write own subscription"
  on public.subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Storage RLS: private videos bucket ──────────────────────────────────
-- The bucket itself is private; users can only touch files under their own
-- folder (videos/{user_id}/…). The backend service role bypasses RLS so it
-- can download any user's video for analysis and delete it afterwards.
create policy "Users manage own videos"
  on storage.objects for all
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Helper: safe user deletion (profile screen) ─────────────────────────
-- Client SDKs can't delete auth users directly; this SECURITY DEFINER runs
-- as the table owner so the signed-in user can delete their own account.
create or replace function public.delete_own_user()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

grant execute on function public.delete_own_user() to authenticated;
