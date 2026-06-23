-- Cool Spots London — Supabase user layer (votes + tags).
-- Run this in the Supabase SQL editor on a fresh free-tier project.
-- The anon key is public; safety comes from the RLS policies below.

-- ---------- tables ----------
create table if not exists public.ac_votes (
  id         uuid primary key default gen_random_uuid(),
  venue_id   text not null,
  choice     text not null check (choice in ('cold','mild','none','unsure')),
  anon_id    text not null,
  created_at timestamptz not null default now(),
  unique (venue_id, anon_id)         -- one vote per device per venue (upsert target)
);

create table if not exists public.venue_tags (
  id         uuid primary key default gen_random_uuid(),
  venue_id   text not null,
  tag        text not null,
  anon_id    text not null,
  created_at timestamptz not null default now(),
  unique (venue_id, tag, anon_id)    -- one of each tag per device per venue
);

create index if not exists ac_votes_venue_idx  on public.ac_votes  (venue_id);
create index if not exists venue_tags_venue_idx on public.venue_tags (venue_id);

-- ---------- row level security ----------
alter table public.ac_votes  enable row level security;
alter table public.venue_tags enable row level security;

-- Anonymous reads (aggregates are computed client-side from these rows).
create policy "ac_votes read"  on public.ac_votes  for select using (true);
create policy "venue_tags read" on public.venue_tags for select using (true);

-- Anonymous inserts (votes / tags). No update/delete from the client.
create policy "ac_votes insert"  on public.ac_votes  for insert with check (true);
create policy "venue_tags insert" on public.venue_tags for insert with check (true);

-- Allow the upsert-on-conflict path for votes to update an existing row.
create policy "ac_votes update" on public.ac_votes
  for update using (true) with check (true);

-- ---------- P2: "suggest a place" moderation queue ----------
create table if not exists public.venue_suggestions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  type       text not null check (type in ('pub','bar','cafe','restaurant','museum')),
  address    text,
  lat        double precision,
  lon        double precision,
  ac_hint    text check (ac_hint in ('cold','mild','none','unsure')),
  note       text,
  anon_id    text,
  status     text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);

alter table public.venue_suggestions enable row level security;

-- Anonymous users may submit suggestions, but NOT read the queue.
-- Moderate from the Supabase dashboard (set status approved/rejected).
create policy "venue_suggestions insert" on public.venue_suggestions
  for insert with check (true);
