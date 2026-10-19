create or replace function public.replace_omie_canonical_items(p_company uuid,p_entity text,p_run uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare row_data jsonb; item_data jsonb; table_name text; header_name text; parent_column text; n integer:=0; exists_header boolean;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode='42501'; end if;
  if p_entity not in ('invoices','orders') or jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Invalid item entity or rows'; end if;
  if not exists(select 1 from public.integration_sync_runs where id=p_run and company_id=p_company and entity=p_entity) then raise exception 'Sync scope mismatch'; end if;
  table_name := case p_entity when 'invoices' then 'canonical_invoice_items' else 'canonical_order_items' end;
  header_name := case p_entity when 'invoices' then 'canonical_invoices' else 'canonical_orders' end;
  parent_column := case p_entity when 'invoices' then 'invoice_external_id' else 'order_external_id' end;
  perform pg_advisory_xact_lock(hashtextextended('biomie.canonical-items:'||p_company::text||':'||p_entity,0));
  for row_data in select * from jsonb_array_elements(p_rows) loop
    if length(coalesce(row_data->>'external_id',''))=0 or jsonb_typeof(row_data->'items') is distinct from 'array' then raise exception 'Parent ID and items array required'; end if;
    execute format('select exists(select 1 from public.%I where company_id=$1 and source=''omie'' and external_id=$2 and sync_run_id=$3)',header_name)
      into exists_header using p_company,row_data->>'external_id',p_run;
    if not exists_header then raise exception 'Canonical header does not belong to this sync'; end if;
    execute format('delete from public.%I where company_id=$1 and source=''omie'' and %I=$2',table_name,parent_column)
      using p_company,row_data->>'external_id';
    for item_data in select * from jsonb_array_elements(row_data->'items') loop
      if (item_data->>'item_sequence')::integer is null or (item_data->>'item_sequence')::integer<1 then raise exception 'Positive item sequence required'; end if;
      execute format('insert into public.%I(company_id,source,%I,item_sequence,product_external_id,description,quantity,unit_price,total,sync_run_id,canonicalized_at)
        values($1,''omie'',$2,$3,$4,$5,$6,$7,$8,$9,now())',table_name,parent_column)
        using p_company,row_data->>'external_id',(item_data->>'item_sequence')::integer,item_data->>'product_external_id',item_data->>'description',
          (item_data->>'quantity')::numeric,(item_data->>'unit_price')::numeric,(item_data->>'total')::numeric,p_run;
      n:=n+1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function public.replace_omie_canonical_items(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.replace_omie_canonical_items(uuid,text,uuid,jsonb) to service_role;

-- Complete promotion definition; obsolete Gold sequences removed in the same transaction.
create or replace function public.promote_omie_gold(p_company uuid, p_entity text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_src text; n int := 0; v_unknown uuid;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  select data_source into v_src from companies where id = p_company and not is_demo;
  if v_src is null or v_src = 'DEMO' then raise exception 'PromoÃ§Ã£o Gold exige empresa real em OMIE_SHADOW ou OMIE.'; end if;

  if p_entity = 'vendors' then
    insert into sellers (company_id, name, active, source, external_id)
      select company_id, name, is_active and not missing_in_source, 'omie', external_id from canonical_vendors where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, active = excluded.active;
    get diagnostics n = row_count;
  elsif p_entity = 'customers' then
    insert into customers (company_id, name, state, city, created_at, source, external_id)
      select company_id, name, coalesce(state,'â€”'), coalesce(city,'â€”'), canonicalized_at::date, 'omie', external_id
      from canonical_customers where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, state = excluded.state, city = excluded.city;
    get diagnostics n = row_count;
  elsif p_entity = 'products' then
    insert into products (company_id, name, category, base_price, sku, source, external_id)
      select company_id, description, coalesce(family,'Sem categoria'), 0, sku, 'omie', external_id
      from canonical_products where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, category = excluded.category, sku = excluded.sku;
    get diagnostics n = row_count;
  elsif p_entity in ('invoices','orders') then
    -- Facts without a known customer are kept under an explicit "Sem cliente" dimension, never dropped.
    insert into customers (company_id, name, state, city, created_at, source, external_id)
      values (p_company, 'Sem cliente identificado', 'â€”', 'â€”', current_date, 'omie', '__unknown__')
    on conflict (company_id, source, external_id) where external_id is not null do nothing;
    select id into v_unknown from customers where company_id = p_company and source = 'omie' and external_id = '__unknown__';
    insert into products (company_id, name, category, base_price, source, external_id)
      values (p_company, 'Produto nÃ£o identificado', 'Sem categoria', 0, 'omie', '__unknown__')
    on conflict (company_id, source, external_id) where external_id is not null do nothing;

    if p_entity = 'invoices' then
      insert into invoices (company_id, seller_id, customer_id, number, status, competence_date, total, source, external_id,
        gross_amount, goods_amount, freight_amount, insurance_amount, other_expenses_amount, discount_amount)
      select ci.company_id, s.id, coalesce(c.id, v_unknown), ci.number,
        case ci.status when 'cancelled' then 'cancelled'::invoice_status when 'denied' then 'denied'::invoice_status else 'authorized'::invoice_status end,
        ci.competence_date, ci.gross_amount, 'omie', ci.external_id,
        ci.gross_amount, ci.goods_amount, ci.freight_amount, ci.insurance_amount, ci.other_expenses_amount, ci.discount_amount
      from canonical_invoices ci
      left join sellers s on s.company_id = ci.company_id and s.source = 'omie' and s.external_id = ci.seller_external_id
      left join customers c on c.company_id = ci.company_id and c.source = 'omie' and c.external_id = ci.customer_external_id
      where ci.company_id = p_company
      on conflict (company_id, source, external_id) where external_id is not null do update set
        seller_id = excluded.seller_id, customer_id = excluded.customer_id, number = excluded.number, status = excluded.status,
        competence_date = excluded.competence_date, total = excluded.total, gross_amount = excluded.gross_amount,
        goods_amount = excluded.goods_amount, freight_amount = excluded.freight_amount, insurance_amount = excluded.insurance_amount,
        other_expenses_amount = excluded.other_expenses_amount, discount_amount = excluded.discount_amount;
      get diagnostics n = row_count;
      delete from public.invoice_items gi using public.invoices gh
      where gi.invoice_id=gh.id and gh.company_id=p_company and gh.source='omie'
        and gi.item_sequence is not null
        and exists(select 1 from public.canonical_invoices ch where ch.company_id=p_company and ch.source='omie' and ch.external_id=gh.external_id)
        and not exists(select 1 from public.canonical_invoice_items ci where ci.company_id=p_company and ci.source='omie' and ci.invoice_external_id=gh.external_id and ci.item_sequence=gi.item_sequence);
      insert into invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select i.id, i.company_id, i.seller_id, coalesce(p.id, (select id from products where company_id = p_company and source='omie' and external_id='__unknown__')),
        it.quantity, it.total, it.item_sequence
      from canonical_invoice_items it
      join invoices i on i.company_id = it.company_id and i.source = 'omie' and i.external_id = it.invoice_external_id
      left join products p on p.company_id = it.company_id and p.source = 'omie' and p.external_id = it.product_external_id
      where it.company_id = p_company
      on conflict (invoice_id, item_sequence) where item_sequence is not null do update set
        product_id = excluded.product_id, quantity = excluded.quantity, total = excluded.total, seller_id = excluded.seller_id;
    else
      insert into sales_orders (company_id, seller_id, customer_id, number, status, order_date, expected_date, total, source, external_id)
      select co.company_id, s.id, coalesce(c.id, v_unknown), co.number,
        case co.status when 'cancelled' then 'cancelled'::order_status when 'invoiced' then 'invoiced'::order_status else 'open'::order_status end,
        co.order_date, co.expected_date, co.total, 'omie', co.external_id
      from canonical_orders co
      left join sellers s on s.company_id = co.company_id and s.source = 'omie' and s.external_id = co.seller_external_id
      left join customers c on c.company_id = co.company_id and c.source = 'omie' and c.external_id = co.customer_external_id
      where co.company_id = p_company
      on conflict (company_id, source, external_id) where external_id is not null do update set
        seller_id = excluded.seller_id, customer_id = excluded.customer_id, status = excluded.status,
        order_date = excluded.order_date, expected_date = excluded.expected_date, total = excluded.total;
      get diagnostics n = row_count;
      delete from public.sales_order_items gi using public.sales_orders gh
      where gi.order_id=gh.id and gh.company_id=p_company and gh.source='omie'
        and gi.item_sequence is not null
        and exists(select 1 from public.canonical_orders ch where ch.company_id=p_company and ch.source='omie' and ch.external_id=gh.external_id)
        and not exists(select 1 from public.canonical_order_items ci where ci.company_id=p_company and ci.source='omie' and ci.order_external_id=gh.external_id and ci.item_sequence=gi.item_sequence);
      insert into sales_order_items (order_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select o.id, o.company_id, o.seller_id, coalesce(p.id, (select id from products where company_id = p_company and source='omie' and external_id='__unknown__')),
        it.quantity, it.total, it.item_sequence
      from canonical_order_items it
      join sales_orders o on o.company_id = it.company_id and o.source = 'omie' and o.external_id = it.order_external_id
      left join products p on p.company_id = it.company_id and p.source = 'omie' and p.external_id = it.product_external_id
      where it.company_id = p_company
      on conflict (order_id, item_sequence) where item_sequence is not null do update set
        product_id = excluded.product_id, quantity = excluded.quantity, total = excluded.total, seller_id = excluded.seller_id;
    end if;
  elsif p_entity = 'receivables' then
    insert into financial_titles (company_id, customer_id, invoice_id, seller_id, document_number, installment, installments,
      issue_date, competence_date, due_date, expected_date, original_amount, interest, fine, discount, cancelled_at, source_status, source, external_id)
    select r.company_id, c.id, i.id, s.id, r.document_number, r.installment, r.installments,
      coalesce(r.issue_date, r.due_date), coalesce(r.competence_date, r.issue_date, r.due_date), r.due_date, r.expected_date,
      r.original_amount, r.interest, r.fine, r.discount, r.cancelled_at, r.source_status, 'omie', r.external_id
    from canonical_receivables r
    left join customers c on c.company_id = r.company_id and c.source = 'omie' and c.external_id = r.customer_external_id
    left join sellers s on s.company_id = r.company_id and s.source = 'omie' and s.external_id = r.seller_external_id
    left join invoices i on i.company_id = r.company_id and i.source = 'omie' and i.external_id = r.invoice_external_id
    where r.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      customer_id = excluded.customer_id, invoice_id = excluded.invoice_id, seller_id = excluded.seller_id,
      due_date = excluded.due_date, expected_date = excluded.expected_date, original_amount = excluded.original_amount,
      interest = excluded.interest, fine = excluded.fine, discount = excluded.discount,
      cancelled_at = excluded.cancelled_at, source_status = excluded.source_status;
    get diagnostics n = row_count;
    insert into financial_settlements (title_id, company_id, settlement_date, amount, source, external_id)
    select t.id, st.company_id, st.settlement_date, st.amount, 'omie', st.external_id
    from canonical_settlements st
    join financial_titles t on t.company_id = st.company_id and t.source = 'omie' and t.external_id = st.receivable_external_id
    where st.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      settlement_date = excluded.settlement_date, amount = excluded.amount, title_id = excluded.title_id;
  else
    raise exception 'Entidade invÃ¡lida: %', p_entity;
  end if;
  return jsonb_build_object('entity', p_entity, 'rows', n);
end $$;
revoke all on function public.promote_omie_gold(uuid,text) from public,anon,authenticated;
grant execute on function public.promote_omie_gold(uuid,text) to service_role;
notify pgrst, 'reload schema';