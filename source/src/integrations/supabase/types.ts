export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string;
          actor_id: string | null;
          created_at: string;
          entity: string;
          entity_id: string | null;
          id: number;
          payload: Json | null;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          created_at?: string;
          entity: string;
          entity_id?: string | null;
          id?: never;
          payload?: Json | null;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          created_at?: string;
          entity?: string;
          entity_id?: string | null;
          id?: never;
          payload?: Json | null;
        };
        Relationships: [];
      };
      branches: {
        Row: {
          company_id: string;
          id: string;
          name: string;
        };
        Insert: {
          company_id: string;
          id?: string;
          name: string;
        };
        Update: {
          company_id?: string;
          id?: string;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "branches_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_customers: {
        Row: {
          canonicalized_at: string;
          city: string | null;
          company_id: string;
          document_hash: string | null;
          document_masked: string | null;
          external_id: string;
          external_seller_id: string | null;
          id: string;
          is_active: boolean;
          last_seen_run_id: string | null;
          legal_name: string | null;
          missing_in_source: boolean;
          name: string;
          person_type: string | null;
          raw_record_id: string | null;
          source: string;
          source_updated_at: string | null;
          state: string | null;
          sync_run_id: string | null;
          trade_name: string | null;
        };
        Insert: {
          canonicalized_at?: string;
          city?: string | null;
          company_id: string;
          document_hash?: string | null;
          document_masked?: string | null;
          external_id: string;
          external_seller_id?: string | null;
          id?: string;
          is_active?: boolean;
          last_seen_run_id?: string | null;
          legal_name?: string | null;
          missing_in_source?: boolean;
          name: string;
          person_type?: string | null;
          raw_record_id?: string | null;
          source?: string;
          source_updated_at?: string | null;
          state?: string | null;
          sync_run_id?: string | null;
          trade_name?: string | null;
        };
        Update: {
          canonicalized_at?: string;
          city?: string | null;
          company_id?: string;
          document_hash?: string | null;
          document_masked?: string | null;
          external_id?: string;
          external_seller_id?: string | null;
          id?: string;
          is_active?: boolean;
          last_seen_run_id?: string | null;
          legal_name?: string | null;
          missing_in_source?: boolean;
          name?: string;
          person_type?: string | null;
          raw_record_id?: string | null;
          source?: string;
          source_updated_at?: string | null;
          state?: string | null;
          sync_run_id?: string | null;
          trade_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_customers_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_entity_matches: {
        Row: {
          biomie_id: string | null;
          candidates: number;
          canonical_id: string;
          company_id: string;
          entity: string;
          id: string;
          method: string;
          note: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          biomie_id?: string | null;
          candidates?: number;
          canonical_id: string;
          company_id: string;
          entity: string;
          id?: string;
          method: string;
          note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status: string;
          updated_at?: string;
        };
        Update: {
          biomie_id?: string | null;
          candidates?: number;
          canonical_id?: string;
          company_id?: string;
          entity?: string;
          id?: string;
          method?: string;
          note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_entity_matches_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_invoice_items: {
        Row: {
          canonicalized_at: string;
          company_id: string;
          description: string | null;
          id: string;
          invoice_external_id: string;
          item_sequence: number;
          product_external_id: string | null;
          quantity: number;
          source: string;
          sync_run_id: string | null;
          total: number;
          unit_price: number;
        };
        Insert: {
          canonicalized_at?: string;
          company_id: string;
          description?: string | null;
          id?: string;
          invoice_external_id: string;
          item_sequence: number;
          product_external_id?: string | null;
          quantity?: number;
          source?: string;
          sync_run_id?: string | null;
          total?: number;
          unit_price?: number;
        };
        Update: {
          canonicalized_at?: string;
          company_id?: string;
          description?: string | null;
          id?: string;
          invoice_external_id?: string;
          item_sequence?: number;
          product_external_id?: string | null;
          quantity?: number;
          source?: string;
          sync_run_id?: string | null;
          total?: number;
          unit_price?: number;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_invoice_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_invoices: {
        Row: {
          canonicalized_at: string;
          company_id: string;
          competence_date: string;
          customer_external_id: string | null;
          discount_amount: number;
          external_id: string;
          freight_amount: number;
          goods_amount: number;
          gross_amount: number;
          id: string;
          insurance_amount: number;
          issue_date: string | null;
          last_seen_run_id: string | null;
          missing_in_source: boolean;
          number: string;
          order_external_id: string | null;
          other_expenses_amount: number;
          raw_record_id: string | null;
          seller_external_id: string | null;
          series: string | null;
          source: string;
          source_updated_at: string | null;
          status: string;
          sync_run_id: string | null;
        };
        Insert: {
          canonicalized_at?: string;
          company_id: string;
          competence_date: string;
          customer_external_id?: string | null;
          discount_amount?: number;
          external_id: string;
          freight_amount?: number;
          goods_amount?: number;
          gross_amount?: number;
          id?: string;
          insurance_amount?: number;
          issue_date?: string | null;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          number: string;
          order_external_id?: string | null;
          other_expenses_amount?: number;
          raw_record_id?: string | null;
          seller_external_id?: string | null;
          series?: string | null;
          source?: string;
          source_updated_at?: string | null;
          status: string;
          sync_run_id?: string | null;
        };
        Update: {
          canonicalized_at?: string;
          company_id?: string;
          competence_date?: string;
          customer_external_id?: string | null;
          discount_amount?: number;
          external_id?: string;
          freight_amount?: number;
          goods_amount?: number;
          gross_amount?: number;
          id?: string;
          insurance_amount?: number;
          issue_date?: string | null;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          number?: string;
          order_external_id?: string | null;
          other_expenses_amount?: number;
          raw_record_id?: string | null;
          seller_external_id?: string | null;
          series?: string | null;
          source?: string;
          source_updated_at?: string | null;
          status?: string;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_invoices_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_order_items: {
        Row: {
          canonicalized_at: string;
          company_id: string;
          description: string | null;
          id: string;
          item_sequence: number;
          order_external_id: string;
          product_external_id: string | null;
          quantity: number;
          source: string;
          sync_run_id: string | null;
          total: number;
          unit_price: number;
        };
        Insert: {
          canonicalized_at?: string;
          company_id: string;
          description?: string | null;
          id?: string;
          item_sequence: number;
          order_external_id: string;
          product_external_id?: string | null;
          quantity?: number;
          source?: string;
          sync_run_id?: string | null;
          total?: number;
          unit_price?: number;
        };
        Update: {
          canonicalized_at?: string;
          company_id?: string;
          description?: string | null;
          id?: string;
          item_sequence?: number;
          order_external_id?: string;
          product_external_id?: string | null;
          quantity?: number;
          source?: string;
          sync_run_id?: string | null;
          total?: number;
          unit_price?: number;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_order_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_orders: {
        Row: {
          canonicalized_at: string;
          company_id: string;
          customer_external_id: string | null;
          expected_date: string | null;
          external_id: string;
          id: string;
          last_seen_run_id: string | null;
          missing_in_source: boolean;
          number: string;
          order_date: string;
          raw_record_id: string | null;
          seller_external_id: string | null;
          source: string;
          source_updated_at: string | null;
          status: string;
          sync_run_id: string | null;
          total: number;
        };
        Insert: {
          canonicalized_at?: string;
          company_id: string;
          customer_external_id?: string | null;
          expected_date?: string | null;
          external_id: string;
          id?: string;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          number: string;
          order_date: string;
          raw_record_id?: string | null;
          seller_external_id?: string | null;
          source?: string;
          source_updated_at?: string | null;
          status: string;
          sync_run_id?: string | null;
          total?: number;
        };
        Update: {
          canonicalized_at?: string;
          company_id?: string;
          customer_external_id?: string | null;
          expected_date?: string | null;
          external_id?: string;
          id?: string;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          number?: string;
          order_date?: string;
          raw_record_id?: string | null;
          seller_external_id?: string | null;
          source?: string;
          source_updated_at?: string | null;
          status?: string;
          sync_run_id?: string | null;
          total?: number;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_orders_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_products: {
        Row: {
          canonicalized_at: string;
          company_id: string;
          description: string;
          external_id: string;
          family: string | null;
          id: string;
          is_active: boolean;
          last_seen_run_id: string | null;
          missing_in_source: boolean;
          raw_record_id: string | null;
          sku: string | null;
          source: string;
          source_updated_at: string | null;
          sync_run_id: string | null;
          unit: string | null;
        };
        Insert: {
          canonicalized_at?: string;
          company_id: string;
          description: string;
          external_id: string;
          family?: string | null;
          id?: string;
          is_active?: boolean;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          raw_record_id?: string | null;
          sku?: string | null;
          source?: string;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
          unit?: string | null;
        };
        Update: {
          canonicalized_at?: string;
          company_id?: string;
          description?: string;
          external_id?: string;
          family?: string | null;
          id?: string;
          is_active?: boolean;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          raw_record_id?: string | null;
          sku?: string | null;
          source?: string;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
          unit?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_products_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_receivables: {
        Row: {
          account_external_id: string | null;
          cancelled_at: string | null;
          canonicalized_at: string;
          category_code: string | null;
          company_id: string;
          competence_date: string | null;
          customer_external_id: string | null;
          discount: number;
          document_number: string;
          due_date: string;
          expected_date: string | null;
          external_id: string;
          fine: number;
          id: string;
          installment: number;
          installments: number;
          interest: number;
          invoice_external_id: string | null;
          issue_date: string | null;
          last_seen_run_id: string | null;
          missing_in_source: boolean;
          original_amount: number;
          raw_record_id: string | null;
          seller_external_id: string | null;
          source: string;
          source_status: string | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          account_external_id?: string | null;
          cancelled_at?: string | null;
          canonicalized_at?: string;
          category_code?: string | null;
          company_id: string;
          competence_date?: string | null;
          customer_external_id?: string | null;
          discount?: number;
          document_number: string;
          due_date: string;
          expected_date?: string | null;
          external_id: string;
          fine?: number;
          id?: string;
          installment?: number;
          installments?: number;
          interest?: number;
          invoice_external_id?: string | null;
          issue_date?: string | null;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          original_amount?: number;
          raw_record_id?: string | null;
          seller_external_id?: string | null;
          source?: string;
          source_status?: string | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          account_external_id?: string | null;
          cancelled_at?: string | null;
          canonicalized_at?: string;
          category_code?: string | null;
          company_id?: string;
          competence_date?: string | null;
          customer_external_id?: string | null;
          discount?: number;
          document_number?: string;
          due_date?: string;
          expected_date?: string | null;
          external_id?: string;
          fine?: number;
          id?: string;
          installment?: number;
          installments?: number;
          interest?: number;
          invoice_external_id?: string | null;
          issue_date?: string | null;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          original_amount?: number;
          raw_record_id?: string | null;
          seller_external_id?: string | null;
          source?: string;
          source_status?: string | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_receivables_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_settlements: {
        Row: {
          account_external_id: string | null;
          amount: number;
          canonicalized_at: string;
          company_id: string;
          external_id: string;
          id: string;
          receivable_external_id: string;
          settlement_date: string;
          source: string;
          sync_run_id: string | null;
        };
        Insert: {
          account_external_id?: string | null;
          amount: number;
          canonicalized_at?: string;
          company_id: string;
          external_id: string;
          id?: string;
          receivable_external_id: string;
          settlement_date: string;
          source?: string;
          sync_run_id?: string | null;
        };
        Update: {
          account_external_id?: string | null;
          amount?: number;
          canonicalized_at?: string;
          company_id?: string;
          external_id?: string;
          id?: string;
          receivable_external_id?: string;
          settlement_date?: string;
          source?: string;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_settlements_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      canonical_vendors: {
        Row: {
          canonicalized_at: string;
          company_id: string;
          email: string | null;
          external_id: string;
          id: string;
          is_active: boolean;
          last_seen_run_id: string | null;
          missing_in_source: boolean;
          name: string;
          raw_record_id: string | null;
          source: string;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          canonicalized_at?: string;
          company_id: string;
          email?: string | null;
          external_id: string;
          id?: string;
          is_active?: boolean;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          name: string;
          raw_record_id?: string | null;
          source?: string;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          canonicalized_at?: string;
          company_id?: string;
          email?: string | null;
          external_id?: string;
          id?: string;
          is_active?: boolean;
          last_seen_run_id?: string | null;
          missing_in_source?: boolean;
          name?: string;
          raw_record_id?: string | null;
          source?: string;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "canonical_vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      channels: {
        Row: {
          company_id: string;
          id: string;
          name: string;
        };
        Insert: {
          company_id: string;
          id?: string;
          name: string;
        };
        Update: {
          company_id?: string;
          id?: string;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channels_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      companies: {
        Row: {
          created_at: string;
          data_source: string;
          id: string;
          is_demo: boolean;
          name: string;
          slug: string;
        };
        Insert: {
          created_at?: string;
          data_source?: string;
          id?: string;
          is_demo?: boolean;
          name: string;
          slug: string;
        };
        Update: {
          created_at?: string;
          data_source?: string;
          id?: string;
          is_demo?: boolean;
          name?: string;
          slug?: string;
        };
        Relationships: [];
      };
      company_integrations: {
        Row: {
          app_key_hint: string | null;
          company_id: string;
          enabled: boolean;
          environment: string;
          last_failure_at: string | null;
          last_success_at: string | null;
          last_test_at: string | null;
          last_test_message: string | null;
          last_test_ok: boolean | null;
          provider: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          app_key_hint?: string | null;
          company_id: string;
          enabled?: boolean;
          environment?: string;
          last_failure_at?: string | null;
          last_success_at?: string | null;
          last_test_at?: string | null;
          last_test_message?: string | null;
          last_test_ok?: boolean | null;
          provider: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          app_key_hint?: string | null;
          company_id?: string;
          enabled?: boolean;
          environment?: string;
          last_failure_at?: string | null;
          last_success_at?: string | null;
          last_test_at?: string | null;
          last_test_message?: string | null;
          last_test_ok?: boolean | null;
          provider?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "company_integrations_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      customers: {
        Row: {
          city: string;
          company_id: string;
          created_at: string;
          document: string | null;
          external_id: string | null;
          id: string;
          name: string;
          source: string;
          state: string;
        };
        Insert: {
          city: string;
          company_id: string;
          created_at?: string;
          document?: string | null;
          external_id?: string | null;
          id?: string;
          name: string;
          source?: string;
          state: string;
        };
        Update: {
          city?: string;
          company_id?: string;
          created_at?: string;
          document?: string | null;
          external_id?: string | null;
          id?: string;
          name?: string;
          source?: string;
          state?: string;
        };
        Relationships: [
          {
            foreignKeyName: "customers_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      dataset_sync_state: {
        Row: {
          company_id: string;
          dataset: string;
          error: string | null;
          id: string;
          last_attempt_at: string | null;
          last_success_at: string | null;
          layer: string;
          records: number | null;
          status: string;
        };
        Insert: {
          company_id: string;
          dataset: string;
          error?: string | null;
          id?: string;
          last_attempt_at?: string | null;
          last_success_at?: string | null;
          layer: string;
          records?: number | null;
          status?: string;
        };
        Update: {
          company_id?: string;
          dataset?: string;
          error?: string | null;
          id?: string;
          last_attempt_at?: string | null;
          last_success_at?: string | null;
          layer?: string;
          records?: number | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "dataset_sync_state_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      financial_accounts: {
        Row: {
          company_id: string;
          external_id: string | null;
          id: string;
          name: string;
          source: string;
        };
        Insert: {
          company_id: string;
          external_id?: string | null;
          id?: string;
          name: string;
          source?: string;
        };
        Update: {
          company_id?: string;
          external_id?: string | null;
          id?: string;
          name?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "financial_accounts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      financial_categories: {
        Row: {
          code: string;
          company_id: string;
          external_id: string | null;
          id: string;
          kind: string;
          name: string;
          source: string;
        };
        Insert: {
          code: string;
          company_id: string;
          external_id?: string | null;
          id?: string;
          kind?: string;
          name: string;
          source?: string;
        };
        Update: {
          code?: string;
          company_id?: string;
          external_id?: string | null;
          id?: string;
          kind?: string;
          name?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "financial_categories_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      financial_settlements: {
        Row: {
          account_id: string | null;
          amount: number;
          company_id: string;
          created_at: string;
          external_id: string | null;
          id: string;
          settlement_date: string;
          source: string;
          title_id: string;
        };
        Insert: {
          account_id?: string | null;
          amount: number;
          company_id: string;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          settlement_date: string;
          source?: string;
          title_id: string;
        };
        Update: {
          account_id?: string | null;
          amount?: number;
          company_id?: string;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          settlement_date?: string;
          source?: string;
          title_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "financial_settlements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "financial_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_settlements_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_settlements_title_id_fkey";
            columns: ["title_id"];
            isOneToOne: false;
            referencedRelation: "financial_titles";
            referencedColumns: ["id"];
          },
        ];
      };
      financial_titles: {
        Row: {
          account_id: string | null;
          cancelled_at: string | null;
          category_id: string | null;
          company_id: string;
          competence_date: string;
          created_at: string;
          customer_id: string | null;
          discount: number;
          document_number: string;
          due_date: string;
          expected_date: string | null;
          external_id: string | null;
          fine: number;
          id: string;
          installment: number;
          installments: number;
          interest: number;
          invoice_id: string | null;
          issue_date: string;
          original_amount: number;
          sales_order_id: string | null;
          seller_id: string | null;
          source: string;
          source_status: string | null;
        };
        Insert: {
          account_id?: string | null;
          cancelled_at?: string | null;
          category_id?: string | null;
          company_id: string;
          competence_date: string;
          created_at?: string;
          customer_id?: string | null;
          discount?: number;
          document_number: string;
          due_date: string;
          expected_date?: string | null;
          external_id?: string | null;
          fine?: number;
          id?: string;
          installment?: number;
          installments?: number;
          interest?: number;
          invoice_id?: string | null;
          issue_date: string;
          original_amount: number;
          sales_order_id?: string | null;
          seller_id?: string | null;
          source?: string;
          source_status?: string | null;
        };
        Update: {
          account_id?: string | null;
          cancelled_at?: string | null;
          category_id?: string | null;
          company_id?: string;
          competence_date?: string;
          created_at?: string;
          customer_id?: string | null;
          discount?: number;
          document_number?: string;
          due_date?: string;
          expected_date?: string | null;
          external_id?: string | null;
          fine?: number;
          id?: string;
          installment?: number;
          installments?: number;
          interest?: number;
          invoice_id?: string | null;
          issue_date?: string;
          original_amount?: number;
          sales_order_id?: string | null;
          seller_id?: string | null;
          source?: string;
          source_status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "financial_titles_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "financial_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_titles_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "financial_categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_titles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_titles_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_titles_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_titles_sales_order_id_fkey";
            columns: ["sales_order_id"];
            isOneToOne: false;
            referencedRelation: "sales_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "financial_titles_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      flight_plan_actions: {
        Row: {
          company_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          message: string;
          month: number;
          priority: number;
          resolved_at: string | null;
          seller_id: string | null;
          status: Database["public"]["Enums"]["fp_action_status"];
          type: string;
          updated_at: string;
          year: number;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          message: string;
          month: number;
          priority?: number;
          resolved_at?: string | null;
          seller_id?: string | null;
          status?: Database["public"]["Enums"]["fp_action_status"];
          type: string;
          updated_at?: string;
          year: number;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          message?: string;
          month?: number;
          priority?: number;
          resolved_at?: string | null;
          seller_id?: string | null;
          status?: Database["public"]["Enums"]["fp_action_status"];
          type?: string;
          updated_at?: string;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "flight_plan_actions_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flight_plan_actions_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      flight_plan_commits: {
        Row: {
          amount: number;
          company_id: string;
          created_at: string;
          created_by: string;
          id: string;
          month: number;
          note: string | null;
          seller_id: string;
          updated_at: string;
          year: number;
        };
        Insert: {
          amount: number;
          company_id: string;
          created_at?: string;
          created_by?: string;
          id?: string;
          month: number;
          note?: string | null;
          seller_id: string;
          updated_at?: string;
          year: number;
        };
        Update: {
          amount?: number;
          company_id?: string;
          created_at?: string;
          created_by?: string;
          id?: string;
          month?: number;
          note?: string | null;
          seller_id?: string;
          updated_at?: string;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "flight_plan_commits_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flight_plan_commits_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      flight_plan_snapshots: {
        Row: {
          active_level: Database["public"]["Enums"]["target_level"];
          company_id: string;
          coverage: number | null;
          created_at: string;
          current_pace: number | null;
          deviation: number | null;
          forecast_base: number | null;
          forecast_commit: number | null;
          forecast_probable: number | null;
          gap: number | null;
          id: string;
          ideal: number | null;
          job_run_id: string | null;
          month: number;
          portfolio: number | null;
          realized: number;
          required_pace: number | null;
          run_rate: number | null;
          seller_id: string | null;
          snapshot_date: string;
          status: string | null;
          target: number;
          updated_at: string;
          working_days_elapsed: number | null;
          working_days_total: number | null;
          year: number;
        };
        Insert: {
          active_level: Database["public"]["Enums"]["target_level"];
          company_id: string;
          coverage?: number | null;
          created_at?: string;
          current_pace?: number | null;
          deviation?: number | null;
          forecast_base?: number | null;
          forecast_commit?: number | null;
          forecast_probable?: number | null;
          gap?: number | null;
          id?: string;
          ideal?: number | null;
          job_run_id?: string | null;
          month: number;
          portfolio?: number | null;
          realized: number;
          required_pace?: number | null;
          run_rate?: number | null;
          seller_id?: string | null;
          snapshot_date: string;
          status?: string | null;
          target: number;
          updated_at?: string;
          working_days_elapsed?: number | null;
          working_days_total?: number | null;
          year: number;
        };
        Update: {
          active_level?: Database["public"]["Enums"]["target_level"];
          company_id?: string;
          coverage?: number | null;
          created_at?: string;
          current_pace?: number | null;
          deviation?: number | null;
          forecast_base?: number | null;
          forecast_commit?: number | null;
          forecast_probable?: number | null;
          gap?: number | null;
          id?: string;
          ideal?: number | null;
          job_run_id?: string | null;
          month?: number;
          portfolio?: number | null;
          realized?: number;
          required_pace?: number | null;
          run_rate?: number | null;
          seller_id?: string | null;
          snapshot_date?: string;
          status?: string | null;
          target?: number;
          updated_at?: string;
          working_days_elapsed?: number | null;
          working_days_total?: number | null;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "flight_plan_snapshots_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flight_plan_snapshots_job_run_id_fkey";
            columns: ["job_run_id"];
            isOneToOne: false;
            referencedRelation: "job_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flight_plan_snapshots_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      holidays: {
        Row: {
          company_id: string | null;
          date: string;
          id: string;
          name: string;
          scope: string;
        };
        Insert: {
          company_id?: string | null;
          date: string;
          id?: string;
          name: string;
          scope?: string;
        };
        Update: {
          company_id?: string | null;
          date?: string;
          id?: string;
          name?: string;
          scope?: string;
        };
        Relationships: [
          {
            foreignKeyName: "holidays_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_backfill_jobs: {
        Row: {
          attempts: number;
          company_id: string;
          created_at: string;
          created_by: string | null;
          current_partition: string | null;
          entity: string;
          id: string;
          last_error: string | null;
          partition_strategy: string;
          partitions_done: number;
          partitions_total: number;
          period_from: string;
          period_to: string;
          priority: number;
          provider: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          company_id: string;
          created_at?: string;
          created_by?: string | null;
          current_partition?: string | null;
          entity: string;
          id?: string;
          last_error?: string | null;
          partition_strategy?: string;
          partitions_done?: number;
          partitions_total?: number;
          period_from: string;
          period_to: string;
          priority?: number;
          provider?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          company_id?: string;
          created_at?: string;
          created_by?: string | null;
          current_partition?: string | null;
          entity?: string;
          id?: string;
          last_error?: string | null;
          partition_strategy?: string;
          partitions_done?: number;
          partitions_total?: number;
          period_from?: string;
          period_to?: string;
          priority?: number;
          provider?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_backfill_jobs_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_sync_runs: {
        Row: {
          backfill_job_id: string | null;
          canonical_complete: boolean;
          checkpoint_end: Json | null;
          checkpoint_start: Json | null;
          company_id: string;
          created: number;
          duration_ms: number | null;
          entity: string;
          error_page: number | null;
          expected_records: number | null;
          failed: number;
          finished_at: string | null;
          gold_complete: boolean;
          id: string;
          message: string | null;
          mode: string;
          pages_done: number;
          pages_total: number | null;
          period_from: string | null;
          period_to: string | null;
          provider: string;
          raw_complete: boolean;
          received: number;
          skipped: number;
          started_at: string;
          status: string;
          triggered_by: string | null;
          updated: number;
        };
        Insert: {
          backfill_job_id?: string | null;
          canonical_complete?: boolean;
          checkpoint_end?: Json | null;
          checkpoint_start?: Json | null;
          company_id: string;
          created?: number;
          duration_ms?: number | null;
          entity: string;
          error_page?: number | null;
          expected_records?: number | null;
          failed?: number;
          finished_at?: string | null;
          gold_complete?: boolean;
          id?: string;
          message?: string | null;
          mode?: string;
          pages_done?: number;
          pages_total?: number | null;
          period_from?: string | null;
          period_to?: string | null;
          provider?: string;
          raw_complete?: boolean;
          received?: number;
          skipped?: number;
          started_at?: string;
          status?: string;
          triggered_by?: string | null;
          updated?: number;
        };
        Update: {
          backfill_job_id?: string | null;
          canonical_complete?: boolean;
          checkpoint_end?: Json | null;
          checkpoint_start?: Json | null;
          company_id?: string;
          created?: number;
          duration_ms?: number | null;
          entity?: string;
          error_page?: number | null;
          expected_records?: number | null;
          failed?: number;
          finished_at?: string | null;
          gold_complete?: boolean;
          id?: string;
          message?: string | null;
          mode?: string;
          pages_done?: number;
          pages_total?: number | null;
          period_from?: string | null;
          period_to?: string | null;
          provider?: string;
          raw_complete?: boolean;
          received?: number;
          skipped?: number;
          started_at?: string;
          status?: string;
          triggered_by?: string | null;
          updated?: number;
        };
        Relationships: [
          {
            foreignKeyName: "integration_sync_runs_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      integrity_issues: {
        Row: {
          check_key: string;
          company_id: string;
          entity: string;
          external_id: string | null;
          first_seen_at: string;
          id: string;
          justification: string | null;
          last_seen_at: string;
          occurrences: number;
          reason: string;
          resolved_at: string | null;
          resolved_by: string | null;
          severity: string;
          status: string;
        };
        Insert: {
          check_key: string;
          company_id: string;
          entity: string;
          external_id?: string | null;
          first_seen_at?: string;
          id?: string;
          justification?: string | null;
          last_seen_at?: string;
          occurrences?: number;
          reason: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          severity?: string;
          status?: string;
        };
        Update: {
          check_key?: string;
          company_id?: string;
          entity?: string;
          external_id?: string | null;
          first_seen_at?: string;
          id?: string;
          justification?: string | null;
          last_seen_at?: string;
          occurrences?: number;
          reason?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          severity?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integrity_issues_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      invoice_items: {
        Row: {
          company_id: string;
          id: string;
          invoice_id: string;
          item_sequence: number | null;
          product_id: string;
          quantity: number;
          seller_id: string | null;
          total: number;
        };
        Insert: {
          company_id: string;
          id?: string;
          invoice_id: string;
          item_sequence?: number | null;
          product_id: string;
          quantity: number;
          seller_id?: string | null;
          total: number;
        };
        Update: {
          company_id?: string;
          id?: string;
          invoice_id?: string;
          item_sequence?: number | null;
          product_id?: string;
          quantity?: number;
          seller_id?: string | null;
          total?: number;
        };
        Relationships: [
          {
            foreignKeyName: "invoice_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_items_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_items_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      invoices: {
        Row: {
          branch_id: string | null;
          channel_id: string | null;
          company_id: string;
          competence_date: string;
          customer_id: string;
          discount_amount: number | null;
          external_id: string | null;
          freight_amount: number | null;
          goods_amount: number | null;
          gross_amount: number | null;
          id: string;
          insurance_amount: number | null;
          number: string;
          other_expenses_amount: number | null;
          seller_id: string | null;
          source: string;
          status: Database["public"]["Enums"]["invoice_status"];
          total: number;
        };
        Insert: {
          branch_id?: string | null;
          channel_id?: string | null;
          company_id: string;
          competence_date: string;
          customer_id: string;
          discount_amount?: number | null;
          external_id?: string | null;
          freight_amount?: number | null;
          goods_amount?: number | null;
          gross_amount?: number | null;
          id?: string;
          insurance_amount?: number | null;
          number: string;
          other_expenses_amount?: number | null;
          seller_id?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["invoice_status"];
          total?: number;
        };
        Update: {
          branch_id?: string | null;
          channel_id?: string | null;
          company_id?: string;
          competence_date?: string;
          customer_id?: string;
          discount_amount?: number | null;
          external_id?: string | null;
          freight_amount?: number | null;
          goods_amount?: number | null;
          gross_amount?: number | null;
          id?: string;
          insurance_amount?: number | null;
          number?: string;
          other_expenses_amount?: number | null;
          seller_id?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["invoice_status"];
          total?: number;
        };
        Relationships: [
          {
            foreignKeyName: "invoices_branch_id_fkey";
            columns: ["branch_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      job_runs: {
        Row: {
          error: string | null;
          finished_at: string | null;
          id: string;
          job_name: string;
          params: Json;
          rows_written: number;
          started_at: string;
          status: string;
          trigger: string;
          triggered_by: string | null;
        };
        Insert: {
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          job_name: string;
          params?: Json;
          rows_written?: number;
          started_at?: string;
          status: string;
          trigger?: string;
          triggered_by?: string | null;
        };
        Update: {
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          job_name?: string;
          params?: Json;
          rows_written?: number;
          started_at?: string;
          status?: string;
          trigger?: string;
          triggered_by?: string | null;
        };
        Relationships: [];
      };
      metric_config: {
        Row: {
          config: Json;
          metric_key: string;
          updated_at: string;
          version: number;
        };
        Insert: {
          config?: Json;
          metric_key: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          config?: Json;
          metric_key?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [];
      };
      products: {
        Row: {
          base_price: number;
          category: string;
          company_id: string;
          external_id: string | null;
          id: string;
          name: string;
          sku: string | null;
          source: string;
        };
        Insert: {
          base_price: number;
          category: string;
          company_id: string;
          external_id?: string | null;
          id?: string;
          name: string;
          sku?: string | null;
          source?: string;
        };
        Update: {
          base_price?: number;
          category?: string;
          company_id?: string;
          external_id?: string | null;
          id?: string;
          name?: string;
          sku?: string | null;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "products_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          default_company_id: string | null;
          email: string | null;
          full_name: string | null;
          id: string;
        };
        Insert: {
          created_at?: string;
          default_company_id?: string | null;
          email?: string | null;
          full_name?: string | null;
          id: string;
        };
        Update: {
          created_at?: string;
          default_company_id?: string | null;
          email?: string | null;
          full_name?: string | null;
          id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_default_company_id_fkey";
            columns: ["default_company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_customers: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_customers_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_customers_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_invoices: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_invoices_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_invoices_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_orders: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_orders_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_orders_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_products: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_products_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_products_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_receivables: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_receivables_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_receivables_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_settlements: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_settlements_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_settlements_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_omie_vendors: {
        Row: {
          company_id: string;
          external_id: string;
          fetched_at: string;
          first_fetched_at: string;
          id: string;
          is_active: boolean | null;
          method: string | null;
          page: number | null;
          payload: Json;
          payload_hash: string;
          processing_error: string | null;
          processing_state: string;
          provider: string;
          requested_period: Json | null;
          source_updated_at: string | null;
          sync_run_id: string | null;
        };
        Insert: {
          company_id: string;
          external_id: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload: Json;
          payload_hash: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Update: {
          company_id?: string;
          external_id?: string;
          fetched_at?: string;
          first_fetched_at?: string;
          id?: string;
          is_active?: boolean | null;
          method?: string | null;
          page?: number | null;
          payload?: Json;
          payload_hash?: string;
          processing_error?: string | null;
          processing_state?: string;
          provider?: string;
          requested_period?: Json | null;
          source_updated_at?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "raw_omie_vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "raw_omie_vendors_sync_run_id_fkey";
            columns: ["sync_run_id"];
            isOneToOne: false;
            referencedRelation: "integration_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      reconciliation_results: {
        Row: {
          abs_diff: number;
          check_key: string;
          check_name: string;
          company_id: string;
          created_at: string;
          dataset: string;
          id: string;
          pct_diff: number | null;
          period: string;
          rule: string;
          run_id: string;
          source_count: number | null;
          source_value: number | null;
          status: string;
          target_count: number | null;
          target_value: number | null;
        };
        Insert: {
          abs_diff: number;
          check_key: string;
          check_name: string;
          company_id: string;
          created_at?: string;
          dataset: string;
          id?: string;
          pct_diff?: number | null;
          period: string;
          rule: string;
          run_id: string;
          source_count?: number | null;
          source_value?: number | null;
          status: string;
          target_count?: number | null;
          target_value?: number | null;
        };
        Update: {
          abs_diff?: number;
          check_key?: string;
          check_name?: string;
          company_id?: string;
          created_at?: string;
          dataset?: string;
          id?: string;
          pct_diff?: number | null;
          period?: string;
          rule?: string;
          run_id?: string;
          source_count?: number | null;
          source_value?: number | null;
          status?: string;
          target_count?: number | null;
          target_value?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "reconciliation_results_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reconciliation_results_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "reconciliation_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      reconciliation_runs: {
        Row: {
          company_id: string;
          finished_at: string | null;
          id: string;
          job_run_id: string | null;
          period: string;
          started_at: string;
          status: string;
          summary: Json;
          triggered_by: string | null;
        };
        Insert: {
          company_id: string;
          finished_at?: string | null;
          id?: string;
          job_run_id?: string | null;
          period: string;
          started_at?: string;
          status?: string;
          summary?: Json;
          triggered_by?: string | null;
        };
        Update: {
          company_id?: string;
          finished_at?: string | null;
          id?: string;
          job_run_id?: string | null;
          period?: string;
          started_at?: string;
          status?: string;
          summary?: Json;
          triggered_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reconciliation_runs_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reconciliation_runs_job_run_id_fkey";
            columns: ["job_run_id"];
            isOneToOne: false;
            referencedRelation: "job_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      sales_order_items: {
        Row: {
          company_id: string;
          id: string;
          item_sequence: number | null;
          order_id: string;
          product_id: string;
          quantity: number;
          seller_id: string | null;
          total: number;
        };
        Insert: {
          company_id: string;
          id?: string;
          item_sequence?: number | null;
          order_id: string;
          product_id: string;
          quantity: number;
          seller_id?: string | null;
          total: number;
        };
        Update: {
          company_id?: string;
          id?: string;
          item_sequence?: number | null;
          order_id?: string;
          product_id?: string;
          quantity?: number;
          seller_id?: string | null;
          total?: number;
        };
        Relationships: [
          {
            foreignKeyName: "sales_order_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_order_items_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "sales_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_order_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_order_items_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      sales_orders: {
        Row: {
          branch_id: string | null;
          channel_id: string | null;
          company_id: string;
          customer_id: string;
          expected_date: string | null;
          external_id: string | null;
          id: string;
          number: string;
          order_date: string;
          seller_id: string | null;
          source: string;
          status: Database["public"]["Enums"]["order_status"];
          total: number;
        };
        Insert: {
          branch_id?: string | null;
          channel_id?: string | null;
          company_id: string;
          customer_id: string;
          expected_date?: string | null;
          external_id?: string | null;
          id?: string;
          number: string;
          order_date: string;
          seller_id?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["order_status"];
          total: number;
        };
        Update: {
          branch_id?: string | null;
          channel_id?: string | null;
          company_id?: string;
          customer_id?: string;
          expected_date?: string | null;
          external_id?: string | null;
          id?: string;
          number?: string;
          order_date?: string;
          seller_id?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["order_status"];
          total?: number;
        };
        Relationships: [
          {
            foreignKeyName: "sales_orders_branch_id_fkey";
            columns: ["branch_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_orders_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_orders_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_orders_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_orders_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      sales_targets: {
        Row: {
          active: boolean;
          amount: number;
          channel_id: string | null;
          company_id: string;
          id: string;
          level: Database["public"]["Enums"]["target_level"];
          month: number;
          seller_id: string | null;
          year: number;
        };
        Insert: {
          active?: boolean;
          amount: number;
          channel_id?: string | null;
          company_id: string;
          id?: string;
          level?: Database["public"]["Enums"]["target_level"];
          month: number;
          seller_id?: string | null;
          year: number;
        };
        Update: {
          active?: boolean;
          amount?: number;
          channel_id?: string | null;
          company_id?: string;
          id?: string;
          level?: Database["public"]["Enums"]["target_level"];
          month?: number;
          seller_id?: string | null;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "sales_targets_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_targets_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_targets_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
        ];
      };
      sales_team_managers: {
        Row: {
          id: string;
          team_id: string;
          user_id: string;
          valid_from: string;
          valid_to: string | null;
        };
        Insert: {
          id?: string;
          team_id: string;
          user_id: string;
          valid_from?: string;
          valid_to?: string | null;
        };
        Update: {
          id?: string;
          team_id?: string;
          user_id?: string;
          valid_from?: string;
          valid_to?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sales_team_managers_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "sales_teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_team_managers_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      sales_team_members: {
        Row: {
          id: string;
          seller_id: string;
          team_id: string;
          valid_from: string;
          valid_to: string | null;
        };
        Insert: {
          id?: string;
          seller_id: string;
          team_id: string;
          valid_from?: string;
          valid_to?: string | null;
        };
        Update: {
          id?: string;
          seller_id?: string;
          team_id?: string;
          valid_from?: string;
          valid_to?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sales_team_members_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "sellers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sales_team_members_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "sales_teams";
            referencedColumns: ["id"];
          },
        ];
      };
      sales_teams: {
        Row: {
          active: boolean;
          company_id: string;
          created_at: string;
          id: string;
          name: string;
        };
        Insert: {
          active?: boolean;
          company_id: string;
          created_at?: string;
          id?: string;
          name: string;
        };
        Update: {
          active?: boolean;
          company_id?: string;
          created_at?: string;
          id?: string;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sales_teams_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      sellers: {
        Row: {
          active: boolean;
          branch_id: string | null;
          channel_id: string | null;
          company_id: string;
          external_id: string | null;
          id: string;
          name: string;
          source: string;
          user_id: string | null;
        };
        Insert: {
          active?: boolean;
          branch_id?: string | null;
          channel_id?: string | null;
          company_id: string;
          external_id?: string | null;
          id?: string;
          name: string;
          source?: string;
          user_id?: string | null;
        };
        Update: {
          active?: boolean;
          branch_id?: string | null;
          channel_id?: string | null;
          company_id?: string;
          external_id?: string | null;
          id?: string;
          name?: string;
          source?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sellers_branch_id_fkey";
            columns: ["branch_id"];
            isOneToOne: false;
            referencedRelation: "branches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sellers_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sellers_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      user_company_access: {
        Row: {
          company_id: string;
          user_id: string;
        };
        Insert: {
          company_id: string;
          user_id: string;
        };
        Update: {
          company_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_company_access_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      user_permissions: {
        Row: {
          created_at: string;
          granted_by: string | null;
          id: string;
          permission: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          granted_by?: string | null;
          id?: string;
          permission: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          granted_by?: string | null;
          id?: string;
          permission?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      calendar_date: {
        Row: {
          date: string | null;
          day: number | null;
          is_holiday: boolean | null;
          is_working_day: boolean | null;
          month: number | null;
          quarter: number | null;
          week: number | null;
          weekday: number | null;
          year: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      accessible_company_ids: { Args: { _user_id: string }; Returns: string[] };
      active_target_level: {
        Args: never;
        Returns: Database["public"]["Enums"]["target_level"];
      };
      assert_company_access: { Args: { p_company: string }; Returns: undefined };
      can_access_company: {
        Args: { _company: string; _user_id: string };
        Returns: boolean;
      };
      can_view_full_document: { Args: never; Returns: boolean };
      can_view_seller: {
        Args: { _seller: string; _user_id: string };
        Returns: boolean;
      };
      can_write_flight_plan: { Args: { _user_id: string }; Returns: boolean };
      cockpit_summary: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_month: number;
          p_seller?: string;
          p_state?: string;
          p_year: number;
        };
        Returns: Json;
      };
      compute_omie_matches: {
        Args: { p_company: string; p_entity: string };
        Returns: Json;
      };
      customer_360: {
        Args: {
          p_as_of: string;
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_customer: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      customer_document: { Args: { p_customer: string }; Returns: string };
      customers_overview: {
        Args: {
          p_as_of: string;
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_inactive_days?: number;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      data_as_of: { Args: { p_company: string }; Returns: string };
      data_freshness: { Args: { p_company: string }; Returns: Json };
      document_hash: { Args: { p: string }; Returns: string };
      fact_orders: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_seller?: string;
          p_state?: string;
        };
        Returns: {
          amount: number;
          category: string;
          customer_id: string;
          expected_date: string;
          number: string;
          order_date: string;
          order_id: string;
          product_id: string;
          qty: number;
          seller_id: string;
          status: Database["public"]["Enums"]["order_status"];
        }[];
      };
      fact_sales: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: {
          amount: number;
          category: string;
          city: string;
          competence_date: string;
          customer_id: string;
          invoice_id: string;
          product_id: string;
          qty: number;
          seller_id: string;
          state: string;
        }[];
      };
      ensure_app_profile: { Args: Record<PropertyKey, never>; Returns: undefined };
      resolve_legacy_login: { Args: { p_identifier: string }; Returns: string | null };
      finance_assert: {
        Args: { p_cap: string; p_company: string };
        Returns: undefined;
      };
      finance_capabilities: { Args: { _user: string }; Returns: string[] };
      finance_customer: {
        Args: { p_company: string; p_customer: string };
        Returns: Json;
      };
      finance_summary: {
        Args: {
          p_branch?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      finance_title_facts: {
        Args: {
          p_branch?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_ref: string;
          p_seller?: string;
          p_state?: string;
        };
        Returns: {
          adjustments: number;
          cancelled: boolean;
          city: string;
          competence_date: string;
          customer_id: string;
          customer_name: string;
          days_late: number;
          document_number: string;
          due_date: string;
          installment: number;
          installments: number;
          invoice_id: string;
          invoice_number: string;
          issue_date: string;
          open: number;
          original: number;
          paid: number;
          seller_id: string;
          seller_name: string;
          settled_date: string;
          state: string;
          status: string;
          title_id: string;
        }[];
      };
      finance_titles_list: {
        Args: {
          p_branch?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_customer?: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      finish_omie_full_sync: {
        Args: { p_company: string; p_entity: string; p_run: string };
        Returns: number;
      };
      flight_plan_dataset: {
        Args: {
          p_as_of?: string;
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_month: number;
          p_seller?: string;
          p_state?: string;
          p_year: number;
        };
        Returns: Json;
      };
      get_integration_credentials: {
        Args: { p_company: string; p_provider: string };
        Returns: {
          app_key: string;
          app_secret: string;
        }[];
      };
      has_broad_scope: { Args: { _user_id: string }; Returns: boolean };
      has_finance_capability: { Args: { _cap: string }; Returns: boolean };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      ingest_omie_raw: {
        Args: {
          p_company: string;
          p_entity: string;
          p_rows: Json;
          p_run: string;
        };
        Returns: Json;
      };
      integration_admin_assert: {
        Args: { p_company: string };
        Returns: undefined;
      };
      is_admin: { Args: { _user_id: string }; Returns: boolean };
      is_seller_restricted: { Args: { _user_id: string }; Returns: boolean };
      is_service_request: { Args: never; Returns: boolean };
      manage_backfill: {
        Args: {
          p_action: string;
          p_company: string;
          p_entity?: string;
          p_from?: string;
          p_job?: string;
          p_priority?: number;
          p_to?: string;
        };
        Returns: string;
      };
      manages_seller: {
        Args: { _seller: string; _user_id: string };
        Returns: boolean;
      };
      mark_raw_processed: {
        Args: {
          p_company: string;
          p_entity: string;
          p_error?: string;
          p_ids: string[];
          p_state: string;
        };
        Returns: undefined;
      };
      mask_document: { Args: { p: string }; Returns: string };
      normalize_text: { Args: { p: string }; Returns: string };
      omie_comparison: {
        Args: { p_company: string; p_entity: string };
        Returns: {
          biomie_active: boolean;
          biomie_id: string;
          biomie_name: string;
          candidates: number;
          canonical_id: string;
          divergence: string;
          external_id: string;
          match_id: string;
          method: string;
          missing_in_source: boolean;
          note: string;
          omie_active: boolean;
          omie_code: string;
          omie_name: string;
          status: string;
        }[];
      };
      omie_migration_status: { Args: { p_company: string }; Returns: Json };
      omie_raw_table: { Args: { p_entity: string }; Returns: string };
      omie_readiness: { Args: { p_company: string }; Returns: Json };
      product_360: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_grain: string;
          p_hist_start: string;
          p_product: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      products_overview: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      promote_omie_gold: {
        Args: { p_company: string; p_entity: string };
        Returns: Json;
      };
      quality_assert: { Args: { p_company: string }; Returns: undefined };
      quality_job_runs: { Args: { p_company: string }; Returns: Json };
      resolve_integrity_issue: {
        Args: { p_issue: string; p_justification: string; p_status: string };
        Returns: undefined;
      };
      resolve_omie_match: {
        Args: {
          p_biomie_id: string;
          p_ignore: boolean;
          p_match: string;
          p_note: string;
        };
        Returns: undefined;
      };
      reveal_customer_document: {
        Args: { p_customer: string; p_reason: string };
        Returns: string;
      };
      revenue_valid_statuses: {
        Args: never;
        Returns: Database["public"]["Enums"]["invoice_status"][];
      };
      run_integrity_checks: { Args: { p_company: string }; Returns: number };
      run_reconciliation: {
        Args: { p_company: string; p_period: string };
        Returns: string;
      };
      sales_aggregate: {
        Args: {
          p_branch: string;
          p_category: string;
          p_channel: string;
          p_city: string;
          p_company: string;
          p_end: string;
          p_seller: string;
          p_start: string;
          p_state: string;
        };
        Returns: Json;
      };
      sales_breakdown: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_dim: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      sales_invoices: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_limit?: number;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      sales_items: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_limit?: number;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      sales_kpis: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      sales_orders_list: {
        Args: {
          p_as_of: string;
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_seller?: string;
          p_state?: string;
        };
        Returns: Json;
      };
      sales_timeline: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_grain: string;
          p_seller?: string;
          p_start: string;
          p_state?: string;
        };
        Returns: Json;
      };
      scheduler_status: { Args: never; Returns: Json };
      seller_history: {
        Args: {
          p_branch?: string;
          p_category?: string;
          p_channel?: string;
          p_city?: string;
          p_company: string;
          p_end: string;
          p_seller: string;
          p_state?: string;
        };
        Returns: Json;
      };
      set_app_base_url: { Args: { p_url: string }; Returns: undefined };
      set_company_data_source: {
        Args: { p_company: string; p_confirmation: string; p_source: string };
        Returns: undefined;
      };
      set_integration_credentials: {
        Args: {
          p_app_key: string;
          p_app_secret: string;
          p_company: string;
          p_environment?: string;
          p_provider: string;
        };
        Returns: undefined;
      };
      verify_job_token: { Args: { p_token: string }; Returns: boolean };
      visible_customer_ids: { Args: { _user_id: string }; Returns: string[] };
      visible_seller_ids: { Args: { _user_id: string }; Returns: string[] };
      working_days: {
        Args: { p_company: string; p_end: string; p_start: string };
        Returns: number;
      };
    };
    Enums: {
      app_role:
        | "SUPER_ADMIN"
        | "ADMIN"
        | "DIRETORIA"
        | "GESTOR"
        | "VENDEDOR"
        | "FINANCEIRO"
        | "ANALISTA"
        | "VIEWER";
      fp_action_status: "OPEN" | "IN_PROGRESS" | "RESOLVED";
      invoice_status: "authorized" | "cancelled" | "denied";
      order_status: "open" | "invoiced" | "cancelled";
      target_level: "BASE" | "ACTIVE" | "CHALLENGE";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "SUPER_ADMIN",
        "ADMIN",
        "DIRETORIA",
        "GESTOR",
        "VENDEDOR",
        "FINANCEIRO",
        "ANALISTA",
        "VIEWER",
      ],
      fp_action_status: ["OPEN", "IN_PROGRESS", "RESOLVED"],
      invoice_status: ["authorized", "cancelled", "denied"],
      order_status: ["open", "invoiced", "cancelled"],
      target_level: ["BASE", "ACTIVE", "CHALLENGE"],
    },
  },
} as const;
