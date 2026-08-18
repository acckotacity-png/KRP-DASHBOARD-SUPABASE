-- KRP shared Terms & Conditions history.
-- Run once in Supabase Dashboard > SQL Editor.

create table if not exists public.business_terms_history (
  id bigint generated always as identity primary key,
  terms_text text not null default '',
  changed_by uuid default auth.uid() references auth.users(id),
  changed_by_name text not null default '',
  changed_at timestamptz not null default now()
);

create index if not exists business_terms_history_changed_at_idx
  on public.business_terms_history (changed_at desc);

alter table public.business_terms_history enable row level security;
drop policy if exists "krp terms history read" on public.business_terms_history;
create policy "krp terms history read" on public.business_terms_history
  for select to authenticated using ((select public.is_krp_user()));
grant select on public.business_terms_history to authenticated;

create or replace function public.capture_business_terms_history()
returns trigger language plpgsql security definer set search_path=public,auth as $$
declare actor_name text;
begin
  if tg_op='INSERT' or new.terms_conditions is distinct from old.terms_conditions then
    select coalesce(nullif(full_name,''),email,'KRP User') into actor_name
      from public.app_users where user_id=(select auth.uid());
    insert into public.business_terms_history(terms_text,changed_by,changed_by_name)
    values(coalesce(new.terms_conditions,''),(select auth.uid()),coalesce(actor_name,'KRP User'));
  end if;
  return new;
end $$;

revoke execute on function public.capture_business_terms_history() from public,anon,authenticated;
drop trigger if exists business_settings_terms_history on public.business_settings;
create trigger business_settings_terms_history
after insert or update of terms_conditions on public.business_settings
for each row execute function public.capture_business_terms_history();

-- Save the current Terms once so history starts with the existing shared value.
insert into public.business_terms_history(terms_text,changed_by,changed_by_name)
select b.terms_conditions,b.updated_by,coalesce(nullif(u.full_name,''),u.email,'KRP User')
from public.business_settings b left join public.app_users u on u.user_id=b.updated_by
where not exists (select 1 from public.business_terms_history);

select changed_by_name,changed_at,terms_text from public.business_terms_history order by changed_at desc limit 10;
