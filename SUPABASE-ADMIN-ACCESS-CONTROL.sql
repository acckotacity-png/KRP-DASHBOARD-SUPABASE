-- KRP Dashboard · Admin access requests and granular permissions
-- Supabase Dashboard > SQL Editor > New query > paste this complete file > Run

create extension if not exists pgcrypto;

alter table public.app_users add column if not exists access_status text not null default 'approved';
alter table public.app_users add column if not exists access_expires_at timestamptz;
alter table public.app_users add column if not exists can_view boolean not null default true;
alter table public.app_users add column if not exists can_create boolean not null default true;
alter table public.app_users add column if not exists can_edit boolean not null default true;
alter table public.app_users add column if not exists can_delete boolean not null default true;
alter table public.app_users add column if not exists can_manage_settings boolean not null default false;
alter table public.app_users add column if not exists reviewed_at timestamptz;
alter table public.app_users add column if not exists reviewed_by uuid references auth.users(id);
alter table public.app_users add column if not exists admin_note text not null default '';

do $$ begin
  alter table public.app_users add constraint app_users_access_status_check
  check (access_status in ('pending','approved','declined','blocked'));
exception when duplicate_object then null; end $$;

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','declined','blocked')),
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  admin_note text not null default '',
  requested_until timestamptz
);

create index if not exists access_requests_status_requested_idx
on public.access_requests(status, requested_at desc);

create or replace function public.is_krp_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.app_users
    where user_id = (select auth.uid())
      and active = true
      and role = 'admin'
      and access_status = 'approved'
      and (access_expires_at is null or access_expires_at > now())
  )
$$;

create or replace function public.has_krp_permission(permission_name text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.app_users
    where user_id = (select auth.uid())
      and active = true
      and access_status = 'approved'
      and (access_expires_at is null or access_expires_at > now())
      and (
        role = 'admin'
        or case lower(permission_name)
          when 'view' then can_view
          when 'create' then can_create
          when 'edit' then can_edit
          when 'delete' then can_delete
          when 'settings' then can_manage_settings
          else false
        end
      )
  )
$$;

create or replace function public.is_krp_user()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_krp_permission('view') $$;

revoke all on function public.has_krp_permission(text) from public;
grant execute on function public.has_krp_permission(text) to authenticated;

create or replace function public.submit_access_request(requested_expiry timestamptz default null)
returns public.access_requests
language plpgsql security definer set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  auth_email text;
  auth_name text;
  existing_status text;
  result public.access_requests;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select email, coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', '')
    into auth_email, auth_name from auth.users where id = uid;
  select status into existing_status from public.access_requests where user_id = uid;
  if existing_status = 'blocked' then raise exception 'This account is blocked'; end if;

  insert into public.access_requests(user_id,email,full_name,status,requested_at,updated_at,requested_until,admin_note,reviewed_at,reviewed_by)
  values(uid,coalesce(auth_email,''),coalesce(auth_name,''),'pending',now(),now(),requested_expiry,'',null,null)
  on conflict(user_id) do update set
    email=excluded.email, full_name=excluded.full_name, status='pending', requested_at=now(), updated_at=now(),
    requested_until=excluded.requested_until, admin_note='', reviewed_at=null, reviewed_by=null
  returning * into result;
  return result;
end $$;

create or replace function public.admin_review_access_request(
  target_user uuid,
  decision text,
  expiry_at timestamptz default null,
  allow_view boolean default true,
  allow_create boolean default false,
  allow_edit boolean default false,
  allow_delete boolean default false,
  allow_settings boolean default false,
  note_text text default ''
)
returns void language plpgsql security definer set search_path = public
as $$
declare req public.access_requests;
begin
  if not public.is_krp_admin() then raise exception 'Admin access required'; end if;
  if decision not in ('approved','declined','blocked') then raise exception 'Invalid decision'; end if;
  select * into req from public.access_requests where user_id=target_user;
  if req.user_id is null then raise exception 'Request not found'; end if;

  update public.access_requests set status=decision, reviewed_at=now(), reviewed_by=auth.uid(),
    updated_at=now(), admin_note=coalesce(note_text,'') where user_id=target_user;

  insert into public.app_users(user_id,email,full_name,role,active,access_status,access_expires_at,
    can_view,can_create,can_edit,can_delete,can_manage_settings,reviewed_at,reviewed_by,admin_note)
  values(target_user,req.email,req.full_name,'staff',decision='approved',decision,expiry_at,
    allow_view,allow_create,allow_edit,allow_delete,allow_settings,now(),auth.uid(),coalesce(note_text,''))
  on conflict(user_id) do update set
    email=excluded.email, full_name=excluded.full_name, active=excluded.active,
    access_status=excluded.access_status, access_expires_at=excluded.access_expires_at,
    can_view=excluded.can_view, can_create=excluded.can_create, can_edit=excluded.can_edit,
    can_delete=excluded.can_delete, can_manage_settings=excluded.can_manage_settings,
    reviewed_at=now(), reviewed_by=auth.uid(), admin_note=excluded.admin_note;
end $$;

create or replace function public.admin_update_user_access(
  target_user uuid,
  new_status text,
  expiry_at timestamptz default null,
  allow_view boolean default true,
  allow_create boolean default false,
  allow_edit boolean default false,
  allow_delete boolean default false,
  allow_settings boolean default false,
  note_text text default ''
)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_krp_admin() then raise exception 'Admin access required'; end if;
  if target_user=auth.uid() and new_status<>'approved' then raise exception 'Admin cannot block own account'; end if;
  if target_user=auth.uid() then
    expiry_at := null;
    allow_view := true; allow_create := true; allow_edit := true;
    allow_delete := true; allow_settings := true;
  end if;
  if new_status not in ('approved','declined','blocked') then raise exception 'Invalid status'; end if;
  update public.app_users set active=(new_status='approved'), access_status=new_status,
    access_expires_at=expiry_at, can_view=allow_view, can_create=allow_create,
    can_edit=allow_edit, can_delete=allow_delete, can_manage_settings=allow_settings,
    reviewed_at=now(), reviewed_by=auth.uid(), admin_note=coalesce(note_text,'')
  where user_id=target_user;
  if not found then raise exception 'User not found'; end if;
  update public.access_requests set status=new_status, updated_at=now(), reviewed_at=now(),
    reviewed_by=auth.uid(), admin_note=coalesce(note_text,'') where user_id=target_user;
end $$;

revoke all on function public.submit_access_request(timestamptz) from public;
revoke all on function public.admin_review_access_request(uuid,text,timestamptz,boolean,boolean,boolean,boolean,boolean,text) from public;
revoke all on function public.admin_update_user_access(uuid,text,timestamptz,boolean,boolean,boolean,boolean,boolean,text) from public;
grant execute on function public.submit_access_request(timestamptz) to authenticated;
grant execute on function public.admin_review_access_request(uuid,text,timestamptz,boolean,boolean,boolean,boolean,boolean,text) to authenticated;
grant execute on function public.admin_update_user_access(uuid,text,timestamptz,boolean,boolean,boolean,boolean,boolean,text) to authenticated;

alter table public.access_requests enable row level security;
drop policy if exists "requester reads own request" on public.access_requests;
drop policy if exists "admin reads all requests" on public.access_requests;
create policy "requester reads own request" on public.access_requests for select to authenticated
using (user_id=(select auth.uid()));
create policy "admin reads all requests" on public.access_requests for select to authenticated
using ((select public.is_krp_admin()));

drop policy if exists "admin reads all users" on public.app_users;
create policy "admin reads all users" on public.app_users for select to authenticated
using ((select public.is_krp_admin()));

do $$
declare table_name text;
begin
  foreach table_name in array array['main_records','monthly_records','transactions','notepad_tasks','udhari_records','expenses','expense_budgets'] loop
    execute format('drop policy if exists "krp_select" on public.%I', table_name);
    execute format('drop policy if exists "krp_insert" on public.%I', table_name);
    execute format('drop policy if exists "krp_update" on public.%I', table_name);
    execute format('drop policy if exists "krp_delete" on public.%I', table_name);
    execute format('create policy "krp_select" on public.%I for select to authenticated using ((select public.has_krp_permission(''view'')))', table_name);
    execute format('create policy "krp_insert" on public.%I for insert to authenticated with check ((select public.has_krp_permission(''create'')) and created_by=(select auth.uid()))', table_name);
    execute format('create policy "krp_update" on public.%I for update to authenticated using ((select public.has_krp_permission(''edit''))) with check ((select public.has_krp_permission(''edit'')))', table_name);
    execute format('create policy "krp_delete" on public.%I for delete to authenticated using ((select public.has_krp_permission(''delete'')))', table_name);
  end loop;
end $$;

drop policy if exists "krp_select" on public.business_settings;
drop policy if exists "krp_insert" on public.business_settings;
drop policy if exists "krp_update" on public.business_settings;
drop policy if exists "krp_delete" on public.business_settings;
create policy "krp_select" on public.business_settings for select to authenticated using ((select public.has_krp_permission('view')));
create policy "krp_insert" on public.business_settings for insert to authenticated with check ((select public.has_krp_permission('settings')) and updated_by=(select auth.uid()));
create policy "krp_update" on public.business_settings for update to authenticated using ((select public.has_krp_permission('settings'))) with check ((select public.has_krp_permission('settings')));
create policy "krp_delete" on public.business_settings for delete to authenticated using ((select public.is_krp_admin()));

grant select on public.access_requests to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.access_requests;
exception when duplicate_object then null; end $$;

-- Existing admin remains fully enabled.
update public.app_users set access_status='approved', active=true, can_view=true, can_create=true,
  can_edit=true, can_delete=true, can_manage_settings=true
where role='admin';
