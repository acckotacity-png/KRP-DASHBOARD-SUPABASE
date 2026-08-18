-- Run once in Supabase Dashboard > SQL Editor.
-- Adds editable defaulter remarks/exclusions without changing ledger data.
alter table public.business_settings
  add column if not exists defaulter_overrides jsonb not null default '[]'::jsonb;

select id, jsonb_array_length(defaulter_overrides) as saved_defaulter_changes
from public.business_settings;
