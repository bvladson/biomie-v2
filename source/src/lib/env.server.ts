/**
 * Central server environment. Read only inside handlers (process.env is
 * request-time on Workers and on Node/VPS). Never hard-code preview/prod URLs.
 */
export type AppEnv = "development" | "homologation" | "production";

export function serverEnv() {
  const raw = process.env["APP_ENV"];
  const appEnv: AppEnv = raw === "production" || raw === "homologation" ? raw : "development";
  const baseUrl = (process.env["APP_BASE_URL"] ?? "").replace(/\/+$/, "") || null;
  return {
    appEnv,
    baseUrl,
    /** Process role on a VPS: web serves HTTP; worker/scheduler run jobs. */
    processRole: (process.env["BIOMIE_PROCESS_ROLE"] ?? "web") as "web" | "worker" | "scheduler",
    omie: {
      globalPerMinute: Number(process.env["OMIE_GLOBAL_PER_MINUTE"] ?? 800),
      perKeyMethodPerMinute: Number(process.env["OMIE_KEY_METHOD_PER_MINUTE"] ?? 200),
      maxConcurrent: Number(process.env["OMIE_MAX_CONCURRENT"] ?? 3),
    },
  };
}
