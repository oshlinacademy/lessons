-- Run once in Supabase: SQL Editor > New query > paste all of this > Run.
-- It sets up private storage for progress and voice notes.

-- Each student's progress, saved as one record.
create table if not exists public.progress (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Parent logins. Anyone signed in whose email is listed here can see progress and voice notes.
create table if not exists public.parents (
  email text primary key
);

create or replace function public.is_parent() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.parents where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

alter table public.progress enable row level security;
alter table public.parents enable row level security;

drop policy if exists "read own or parent" on public.progress;
create policy "read own or parent" on public.progress for select to authenticated
  using (auth.uid() = user_id or public.is_parent());
drop policy if exists "add own" on public.progress;
create policy "add own" on public.progress for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "change own" on public.progress;
create policy "change own" on public.progress for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Voice notes: a private folder per student.
insert into storage.buckets (id, name, public) values ('voice', 'voice', false)
  on conflict (id) do nothing;

drop policy if exists "voice add own" on storage.objects;
create policy "voice add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'voice' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "voice replace own" on storage.objects;
create policy "voice replace own" on storage.objects for update to authenticated
  using (bucket_id = 'voice' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "voice read own or parent" on storage.objects;
create policy "voice read own or parent" on storage.objects for select to authenticated
  using (bucket_id = 'voice' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_parent()));
