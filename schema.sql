-- ============================================
-- Tabi Host v3 — Supabase SQL Schema
-- Run this in Supabase SQL Editor
-- ============================================

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  api_key text unique not null,
  label text default 'My API',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  api_key_id uuid references api_keys(id) on delete set null,
  label text not null,
  language text not null,
  version text default 'latest',
  entry_file text not null,
  drive_folder_id text,
  drive_file_id text,
  status text default 'active',
  created_at timestamptz default now()
);

create table if not exists request_logs (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid references deployments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  input_data text,
  output_data text,
  exit_code integer,
  run_time_ms integer,
  created_at timestamptz default now()
);

create index if not exists idx_deployments_user on deployments(user_id);
create index if not exists idx_api_keys_key on api_keys(api_key);
create index if not exists idx_logs_deploy on request_logs(deployment_id);
