import type { FlightPlanApi } from "./contract";
import { serverFlightPlanApi } from "./server-client";

/** As telas usam só esta exportação; o simulador (api/mock.ts) fica para os testes. */
export const flightPlanApi: FlightPlanApi = serverFlightPlanApi;
