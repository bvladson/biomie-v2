-- Legacy 'nao_autorizada' documents are kept, visible and never counted as revenue.
alter type public.invoice_status add value if not exists 'not_authorized';
