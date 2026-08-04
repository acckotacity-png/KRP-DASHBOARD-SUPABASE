-- KRP Dashboard · Supabase database schema
-- Supabase Dashboard > SQL Editor me is poori file ko ek baar Run karein.

create extension if not exists pgcrypto;

create table if not exists public.app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text default '',
  role text not null default 'staff' check (role in ('admin','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.is_krp_user()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.app_users where user_id = (select auth.uid()) and active = true) $$;

create or replace function public.is_krp_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.app_users where user_id = (select auth.uid()) and active = true and role = 'admin') $$;

revoke all on function public.is_krp_user() from public;
revoke all on function public.is_krp_admin() from public;
grant execute on function public.is_krp_user() to authenticated;
grant execute on function public.is_krp_admin() to authenticated;

create table if not exists public.main_records (
  id uuid primary key default gen_random_uuid(), sequence_no bigint generated always as identity,
  invoice_no text not null default '', entry_date text not null default '', contact_name text not null default '', customer_name text not null default '',
  bank_owner text default '', state text default '', purpose text default '', service_remarks text default '', login_id text default '',
  dealing_amount numeric(14,2) not null default 0, amount_deno text not null default '',
  received_amount numeric(14,2) not null default 0, id_activation_amount numeric(14,2) not null default 0,
  uploading_amount numeric(14,2) not null default 0, utr_no text default '', payment_status text not null default 'PENDING', remarks text default '',
  created_by uuid not null default auth.uid() references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

alter table public.main_records add column if not exists customer_name text not null default '';

create table if not exists public.business_settings (
  id smallint primary key default 1 check (id = 1), business_name text default '', contact_number text default '', email_address text default '',
  gstin text default '', business_address text default '', account_holder_name text default '', account_number text default '', ifsc text default '',
  upi_id text default '', terms_conditions text default '', purpose_options jsonb not null default '[]'::jsonb,
  financial_year_options jsonb not null default '[]'::jsonb,
  updated_by uuid default auth.uid() references auth.users(id), updated_at timestamptz not null default now()
);

create table if not exists public.monthly_records (
  id uuid primary key default gen_random_uuid(), sequence_no bigint generated always as identity,
  entry_date text default '', month text default '', total_id integer not null default 0, working_amount numeric(14,2) not null default 0,
  transfer_amount numeric(14,2) not null default 0, monthly_amount numeric(14,2) not null default 0,
  setup_amount numeric(14,2) not null default 0, remarks text default '', created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(), sequence_no bigint generated always as identity,
  entry_date text default '', month text default '', total_id integer not null default 0, working_amount numeric(14,2) not null default 0,
  transfer_amount numeric(14,2) not null default 0, monthly_paid numeric(14,2) not null default 0,
  other_amount numeric(14,2) not null default 0, remarks text default '', created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.notepad_tasks (
  id uuid primary key default gen_random_uuid(), sequence_no bigint generated always as identity,
  task_date text default '', contact_no text default '', state text default '', customer_name text default '', login_id text default '', password_text text default '',
  task_description text default '', task_status text not null default 'PENDING', payment_date text default '', dealing_amount numeric(14,2) not null default 0,
  received_amount numeric(14,2) not null default 0, reminder_date text default '', created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.udhari_records (
  id uuid primary key default gen_random_uuid(), sequence_no bigint generated always as identity,
  entry_date text default '', customer_name text default '', mobile_no text default '', address text default '', transaction_type text not null default 'UDHAR DIYA',
  description text default '', udhar_amount numeric(14,2) not null default 0, payment_amount numeric(14,2) not null default 0,
  due_date text default '', payment_mode text default '', reference_no text default '', reminder_date text default '', remarks text default '',
  interest_rate numeric(8,2) not null default 0, interest_type text default 'MONTHLY', interest_start_date text default '',
  created_by_email text default '', created_by uuid not null default auth.uid() references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(), sequence_no bigint generated always as identity,
  entry_date text default '', category text not null default 'OTHER', sub_category text default '', description text default '',
  amount numeric(14,2) not null default 0, payment_mode text default '', paid_to text default '', reference_no text default '', bill_link text default '',
  expense_type text default 'VARIABLE', priority text default 'IMPORTANT', added_by_email text default '',
  created_by uuid not null default auth.uid() references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.expense_budgets (
  id uuid primary key default gen_random_uuid(), month text not null, category text not null,
  monthly_budget numeric(14,2) not null default 0, warning_limit numeric(6,2) not null default 80,
  notes text default '', active boolean not null default true, created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(month, category)
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key, table_name text not null, record_id text,
  operation text not null, old_data jsonb, new_data jsonb, changed_by uuid default auth.uid(), changed_at timestamptz not null default now()
);

create index if not exists main_records_sequence_idx on public.main_records(sequence_no);
create index if not exists main_records_invoice_idx on public.main_records(invoice_no);
create index if not exists main_records_contact_idx on public.main_records(contact_name);
create index if not exists main_records_customer_name_idx on public.main_records(customer_name);
create index if not exists monthly_records_sequence_idx on public.monthly_records(sequence_no);
create index if not exists transactions_sequence_idx on public.transactions(sequence_no);
create index if not exists notepad_tasks_sequence_idx on public.notepad_tasks(sequence_no);
create index if not exists udhari_mobile_sequence_idx on public.udhari_records(mobile_no, sequence_no);
create index if not exists expenses_sequence_idx on public.expenses(sequence_no);
create index if not exists expense_budgets_month_category_idx on public.expense_budgets(month, category);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create or replace function public.write_audit_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log(table_name, record_id, operation, old_data, new_data, changed_by)
  values (tg_table_name, coalesce(new.id::text, old.id::text), tg_op,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
          (select auth.uid()));
  return coalesce(new, old);
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['main_records','business_settings','monthly_records','transactions','notepad_tasks','udhari_records','expenses','expense_budgets'] loop
    execute format('drop trigger if exists %I_touch on public.%I', table_name, table_name);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', table_name, table_name);
    execute format('drop trigger if exists %I_audit on public.%I', table_name, table_name);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.write_audit_log()', table_name, table_name);
  end loop;
end $$;

alter table public.app_users enable row level security;
alter table public.main_records enable row level security;
alter table public.business_settings enable row level security;
alter table public.monthly_records enable row level security;
alter table public.transactions enable row level security;
alter table public.notepad_tasks enable row level security;
alter table public.udhari_records enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_budgets enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "user reads own access" on public.app_users;
create policy "user reads own access" on public.app_users for select to authenticated using (user_id = (select auth.uid()));

do $$
declare table_name text;
begin
  foreach table_name in array array['main_records','monthly_records','transactions','notepad_tasks','udhari_records','expenses','expense_budgets'] loop
    execute format('drop policy if exists "krp_select" on public.%I', table_name);
    execute format('drop policy if exists "krp_insert" on public.%I', table_name);
    execute format('drop policy if exists "krp_update" on public.%I', table_name);
    execute format('drop policy if exists "krp_delete" on public.%I', table_name);
    execute format('create policy "krp_select" on public.%I for select to authenticated using ((select public.is_krp_user()))', table_name);
    execute format('create policy "krp_insert" on public.%I for insert to authenticated with check ((select public.is_krp_user()) and created_by = (select auth.uid()))', table_name);
    execute format('create policy "krp_update" on public.%I for update to authenticated using ((select public.is_krp_user())) with check ((select public.is_krp_user()))', table_name);
    execute format('create policy "krp_delete" on public.%I for delete to authenticated using ((select public.is_krp_user()))', table_name);
  end loop;
end $$;

drop policy if exists "krp_select" on public.business_settings;
drop policy if exists "krp_insert" on public.business_settings;
drop policy if exists "krp_update" on public.business_settings;
drop policy if exists "krp_delete" on public.business_settings;
create policy "krp_select" on public.business_settings for select to authenticated using ((select public.is_krp_user()));
create policy "krp_insert" on public.business_settings for insert to authenticated with check ((select public.is_krp_user()) and updated_by = (select auth.uid()));
create policy "krp_update" on public.business_settings for update to authenticated using ((select public.is_krp_user())) with check ((select public.is_krp_user()));
create policy "krp_delete" on public.business_settings for delete to authenticated using ((select public.is_krp_admin()));

drop policy if exists "admins read audit" on public.audit_log;
create policy "admins read audit" on public.audit_log for select to authenticated using ((select public.is_krp_admin()));

grant select on public.app_users to authenticated;
grant select, insert, update, delete on public.main_records, public.business_settings, public.monthly_records,
  public.transactions, public.notepad_tasks, public.udhari_records, public.expenses, public.expense_budgets to authenticated;
grant select on public.audit_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- FIRST USER ADD KARNE KA EXAMPLE (Google login ek baar karne ke baad SQL Editor me chalayein):
-- insert into public.app_users(user_id,email,full_name,role,active)
-- select id,email,coalesce(raw_user_meta_data->>'full_name',''),'admin',true from auth.users
-- where lower(email)=lower('YOUR_EMAIL@gmail.com') on conflict (user_id) do update set active=true, role='admin';
