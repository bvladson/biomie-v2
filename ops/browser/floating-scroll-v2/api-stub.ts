import { createMockApi } from "../../../source/src/estoque/dev/mock-api";

// Existing deterministic test API, isolated from Supabase, Omie and live records.
export const stockApi = createMockApi("SUPER_ADMIN", 82, 10).api;
