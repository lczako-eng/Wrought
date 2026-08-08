-- ============================================================================
-- WROUGHT — schema 002: OAuth 2.1
--
-- This is what makes "Sign in with Wrought" appear inside ChatGPT and Claude
-- instead of asking a human being to copy a JWT out of a web page and paste it
-- into a connector settings box. Nobody does that twice.
--
-- OAuth 2.1 with PKCE and dynamic client registration, because MCP clients
-- register themselves — there is no console where someone adds ChatGPT by hand.
--
-- Everything secret is stored hashed. A dump of these tables yields no usable
-- credential: codes and tokens are SHA-256, and the plaintext exists only in
-- the response that created it.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ── Clients ─────────────────────────────────────────────────────────────────
-- Registered by the MCP client itself at first connect (RFC 7591). ChatGPT and
-- Claude each land here on their own, unattended.

create table if not exists public.wrought_oauth_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris text[] not null,
  grant_types   text[] not null default array['authorization_code','refresh_token'],
  scope         text not null default 'wrought',
  created_at    timestamptz not null default now()
);

comment on table public.wrought_oauth_clients is
  'Self-registered MCP clients. Public clients only — PKCE replaces the client secret, which a desktop app could never keep anyway.';

-- ── Authorization codes ─────────────────────────────────────────────────────
-- Single use, short lived, bound to a PKCE challenge. Stored hashed so a
-- database read cannot replay one.

create table if not exists public.wrought_oauth_codes (
  code_hash       text primary key,
  client_id       text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  challenge_method text not null default 'S256',
  expires_at      timestamptz not null,
  used            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists wrought_oauth_codes_expiry_idx on public.wrought_oauth_codes (expires_at);

-- ── Access and refresh tokens ───────────────────────────────────────────────
-- Access tokens are what getAuthUser() checks on every MCP call. Refresh
-- tokens are why signing in once actually means once — the connector renews
-- silently and the user never sees a login again.

create table if not exists public.wrought_oauth_tokens (
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   text,
  scope       text not null default 'wrought',
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists wrought_oauth_tokens_user_idx   on public.wrought_oauth_tokens (user_id);
create index if not exists wrought_oauth_tokens_expiry_idx on public.wrought_oauth_tokens (expires_at);

create table if not exists public.wrought_oauth_refresh (
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   text,
  scope       text not null default 'wrought',
  revoked     boolean not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists wrought_oauth_refresh_user_idx on public.wrought_oauth_refresh (user_id);

-- ── Lock it all down ────────────────────────────────────────────────────────
-- RLS on, no policies at all. These tables are service-role only: a browser
-- holding the anon key must never be able to read a token row, hashed or not.

alter table public.wrought_oauth_clients enable row level security;
alter table public.wrought_oauth_codes   enable row level security;
alter table public.wrought_oauth_tokens  enable row level security;
alter table public.wrought_oauth_refresh enable row level security;

-- ── Housekeeping ────────────────────────────────────────────────────────────
-- Expired codes and tokens are litter. Call this from a scheduled function, or
-- run it by hand now and then — nothing breaks if it never runs, the tables
-- just grow.

create or replace function public.wrought_oauth_gc()
returns void language sql security definer set search_path = public as $$
  delete from public.wrought_oauth_codes  where expires_at < now() - interval '1 day';
  delete from public.wrought_oauth_tokens where expires_at < now() - interval '7 days';
  delete from public.wrought_oauth_refresh where expires_at < now() - interval '30 days';
$$;
