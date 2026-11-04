/**
 * Motor usado pelo simulador e pelos testes: é o motor oficial do Plano de Voo
 * (src/domain/flight-plan/engine.ts) com a configuração padrão. Uma regra só.
 */
import type { OpenOrder as DomainOpenOrder } from "@/domain/flight-plan/engine";

export * from "@/domain/flight-plan/engine";

/** No simulador todo pedido tem vendedor e cliente. */
export type OpenOrder = DomainOpenOrder & { sellerId: string; customer: string };
