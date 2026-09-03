-- 028_wrought_oauth_secret.sql
-- A confidential OAuth client — one that can keep a secret — beside the
-- public ones.
--
-- Every MCP client so far is public: a desktop app or a browser extension
-- that cannot hold a secret, so PKCE binds the code to whoever requested it.
-- A custom ChatGPT (a "GPT" with Actions) is the other kind. OpenAI's servers
-- hold its credentials, it does not do PKCE, and it presents a client id and
-- secret at the token endpoint instead. Without a secret to check, the only
-- honest answer to such a client is to refuse — so this column is what lets
-- the Actions door exist at all.
--
-- Stored hashed, like every other secret here. Null for every public client,
-- which is every client registered before this.

alter table public.wrought_oauth_clients add column if not exists client_secret_hash text;

comment on column public.wrought_oauth_clients.client_secret_hash is
  'SHA-256 of the client secret, for confidential clients (ChatGPT Actions). Null for public clients, which use PKCE instead.';
