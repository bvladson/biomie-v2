-- Integration admins are still subject to legacy channel grants when inspecting
-- Canonical facts. RAW/configuration remain service-only as before.
create policy "legacy canonical invoice channel" on public.canonical_invoices as restrictive for select to authenticated
  using(public.legacy_channel_allowed(company_id,business_channel));
create policy "legacy canonical invoice item channel" on public.canonical_invoice_items as restrictive for select to authenticated
  using(exists(select 1 from public.canonical_invoices i where i.company_id=canonical_invoice_items.company_id
    and i.source=canonical_invoice_items.source and i.external_id=invoice_external_id
    and public.legacy_channel_allowed(i.company_id,i.business_channel)));
create policy "legacy canonical order channel" on public.canonical_orders as restrictive for select to authenticated
  using(public.legacy_channel_allowed(company_id,business_channel));
create policy "legacy canonical order item channel" on public.canonical_order_items as restrictive for select to authenticated
  using(exists(select 1 from public.canonical_orders o where o.company_id=canonical_order_items.company_id
    and o.source=canonical_order_items.source and o.external_id=order_external_id
    and public.legacy_channel_allowed(o.company_id,o.business_channel)));
create policy "legacy canonical receivable channel" on public.canonical_receivables as restrictive for select to authenticated
  using(public.legacy_channel_allowed(company_id,business_channel));
create policy "legacy canonical settlement channel" on public.canonical_settlements as restrictive for select to authenticated
  using(exists(select 1 from public.canonical_receivables r where r.company_id=canonical_settlements.company_id
    and r.source=canonical_settlements.source and r.external_id=receivable_external_id
    and public.legacy_channel_allowed(r.company_id,r.business_channel)));
notify pgrst, 'reload schema';
