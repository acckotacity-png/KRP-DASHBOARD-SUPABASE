# Supabase aur GitHub Pages Setup

## 1. Supabase project

1. Supabase me naya project banayein.
2. SQL Editor kholkar `supabase-schema.sql` ka poora code Run karein.
3. Authentication > Providers me Google enable karein.
4. Google Cloud OAuth client me Supabase ka callback URL add karein. Supabase provider page par exact callback URL diya hota hai.
5. Authentication > URL Configuration me GitHub Pages URL add karein:
   - Site URL: `https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY/`
   - Redirect URL: `https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY/login.html`

## 2. Public browser configuration

Supabase Dashboard > Project Settings/API se Project URL aur **Publishable Key** lekar `supabase-config.js` me paste karein.

Publishable key frontend me dikh sakti hai; security RLS policies deti hain. `service_role`, `sb_secret` ya database password kabhi GitHub/HTML/JavaScript me paste na karein.

## 3. First admin ko access dena

1. GitHub Pages par site open karke Google login ek baar karein. Pehli baar `Access denied` aana expected hai; isse Supabase Auth user create ho jayega.
2. Supabase SQL Editor me yeh chalayein (email replace karein):

```sql
insert into public.app_users(user_id,email,full_name,role,active)
select id,email,coalesce(raw_user_meta_data->>'full_name',''),'admin',true
from auth.users
where lower(email)=lower('YOUR_EMAIL@gmail.com')
on conflict (user_id) do update set active=true, role='admin';
```

3. Dobara login karein.

## 4. New user ko access dena

User se site par Google login ek baar karwayein, phir SQL Editor me:

```sql
insert into public.app_users(user_id,email,full_name,role,active)
select id,email,coalesce(raw_user_meta_data->>'full_name',''),'staff',true
from auth.users
where lower(email)=lower('NEW_USER@gmail.com')
on conflict (user_id) do update set active=true;
```

Access band karne ke liye:

```sql
update public.app_users set active=false where lower(email)=lower('USER@gmail.com');
```

## 5. GitHub Pages deployment

1. Is folder ke sab files ek **new repository** me upload karein.
2. Repository > Settings > Pages kholein.
3. Source: Deploy from a branch, Branch: `main`, Folder: `/ (root)` select karke Save karein.
4. Pages URL ko Supabase Authentication URL Configuration me add karna na bhoolein.

## 6. Existing Google Sheet data migration

Supabase Table Editor me related table kholkar CSV import kar sakte hain. UTR/reference/mobile/invoice columns ko text hi rakhein. Import se pehle ek backup zaroor rakhein. Recommended mapping:

- Sheet1 → `main_records`
- Sheet2 → `monthly_records`
- Transection Sheet → `transactions`
- Notepad → `notepad_tasks`
- Udhari → `udhari_records`
- Daily Expenses → `expenses`
- Expense Budgets → `expense_budgets`

Calculated fields (transaction remaining, Udhari interest/status, expense budget warnings) browser data layer runtime par calculate karti hai; unke liye extra database columns required nahi hain.

## 7. Session timeout

`supabase-config.js` me `idleLogoutMinutes: 5` ko required minutes se replace kar sakte hain.
