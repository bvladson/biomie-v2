-- An ADMIN with access to one company cannot grant itself another tenant.
drop policy "admin grants access" on public.user_company_access;
drop policy "admin revokes access" on public.user_company_access;
create policy "admin grants access" on public.user_company_access for insert to authenticated
  with check(public.has_role(auth.uid(),'SUPER_ADMIN')
    or (public.is_admin(auth.uid()) and public.can_access_company(auth.uid(),company_id)));
create policy "admin revokes access" on public.user_company_access for delete to authenticated
  using(public.has_role(auth.uid(),'SUPER_ADMIN')
    or (public.is_admin(auth.uid()) and public.can_access_company(auth.uid(),company_id)));

-- V2 roles apply globally. A tenant administrator must not change another
-- company's effective role by granting a global capability to a shared user.
drop policy "admin grants roles" on public.user_roles;
drop policy "admin revokes roles" on public.user_roles;
create policy "admin grants roles" on public.user_roles for insert to authenticated
  with check(public.has_role(auth.uid(),'SUPER_ADMIN'));
create policy "admin revokes roles" on public.user_roles for delete to authenticated
  using(public.has_role(auth.uid(),'SUPER_ADMIN') and user_id<>auth.uid());
notify pgrst, 'reload schema';
