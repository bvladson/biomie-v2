/** Ponto único de acesso aos dados do Admin: as telas nunca chamam o servidor por outro caminho. */
import type { AdminApi } from "./contract";
import { serverAdminApi } from "./server-client";

export const adminApi: AdminApi = serverAdminApi;
export * from "./contract";
