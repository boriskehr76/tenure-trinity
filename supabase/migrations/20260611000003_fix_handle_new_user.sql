-- Bug fix: handle_new_user ran as supabase_auth_admin, whose search_path does
-- not include public, so the unqualified "insert into profiles" failed on every
-- signup and the exception handler swallowed it. Schema-qualify and pin
-- search_path, then backfill profiles for existing auth users.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        name = excluded.name;
  return new;
end;
$function$;

insert into public.profiles (id, email, name)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', '')
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- The pre-existing profile row was created before the trigger ran correctly
-- and never got its email/name populated.
update public.profiles p
set email = u.email,
    name = coalesce(p.name, u.raw_user_meta_data->>'full_name', '')
from auth.users u
where u.id = p.id and p.email is null;
