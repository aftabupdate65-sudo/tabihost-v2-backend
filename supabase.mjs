// supabase.mjs
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

/*
=============================================
SUPABASE SQL SCHEMA — run in SQL editor
=============================================

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  api_key text unique not null,
  label text default 'Default',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  api_key_id uuid references api_keys(id) on delete cascade,
  label text not null,
  status text default 'building',  -- building | running | stopped | failed
  container_id text,
  container_port integer,
  drive_file_id text,
  drive_folder_id text,
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists request_logs (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid references deployments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  method text,
  path text,
  status_code integer,
  duration_ms integer,
  created_at timestamptz default now()
);

create index if not exists idx_deployments_user on deployments(user_id);
create index if not exists idx_api_keys_key on api_keys(api_key);
create index if not exists idx_logs_deployment on request_logs(deployment_id);

=============================================
*/
