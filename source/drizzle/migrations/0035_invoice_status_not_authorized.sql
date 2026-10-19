-- Legacy 'nao_autorizada' documents are kept, visible and never counted as revenue.
alter type public.invoice_status add value if not exists 'not_authorized';
alter table public.canonical_invoices drop constraint if exists canonical_invoice_status_known;
alter table public.canonical_invoices add constraint canonical_invoice_status_known
  check (status in ('authorized','cancelled','denied','not_authorized'));
