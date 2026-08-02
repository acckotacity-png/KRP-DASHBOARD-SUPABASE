# KRP Dashboard · Supabase Edition

Yeh original KRP Dashboard ki independent copy hai. UI aur workflow same rakha gaya hai, lekin Google Apps Script/Firebase data layer ko Supabase PostgreSQL + Auth + RLS se replace kiya gaya hai.

## Files

- `index.html` — main dashboard
- `login.html` — Google sign-in
- `supabase-api.js` — existing UI aur Supabase ke beech compatibility/data layer
- `supabase-config.js` — Project URL aur publishable key
- `supabase-schema.sql` — tables, indexes, audit log aur RLS policies
- `SUPABASE-SETUP.md` — complete setup/deployment guide

## Security

- Anonymous visitors ko database access nahi milta.
- Sirf `app_users` me active users data access kar sakte hain.
- Har exposed table par RLS enabled hai.
- Insert/update/delete ka audit log banta hai.
- `service_role` ya secret key frontend me kabhi use nahi hoti.

Setup ke liye `SUPABASE-SETUP.md` follow karein.
