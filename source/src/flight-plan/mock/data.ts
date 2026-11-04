/** Dados fictícios e determinísticos do protótipo (nenhum dado real). */
import type { Channel, Company, Money, Seller, TargetSet } from "../api/contract";
import { addDays, addMonths, daysOfMonth, weekday } from "../lib/dates";
import type { OpenOrder } from "./engine";

export const AS_OF = "2026-11-18";
export const CURRENT_MONTH = "2026-11";
export const HISTORY_START = "2025-11";
export const SNAPSHOTS_SINCE = "2026-10-19";
export const CONVERSION_SINCE = "2026-11-10";

export const COMPANIES: Company[] = [
  { id: "ergooffice", slug: "ergooffice", name: "Ergo Office", asOf: AS_OF, saturdayWeight: 0 },
  {
    id: "expert",
    slug: "expert",
    name: "Expert Móveis e Licitações",
    asOf: AS_OF,
    saturdayWeight: 0,
  },
  {
    id: "mag-filial",
    slug: "mag-filial",
    name: "Mag Móveis – Filial",
    asOf: AS_OF,
    saturdayWeight: 0.33,
  },
  {
    id: "mag-matriz",
    slug: "mag-matriz",
    name: "Mag Móveis – Matriz",
    asOf: AS_OF,
    saturdayWeight: 0,
  },
  { id: "uni-design", slug: "uni-design", name: "Uni Design", asOf: AS_OF, saturdayWeight: 0.33 },
];

export const HOLIDAYS = new Map<string, string>([
  ["2025-11-02", "Finados"],
  ["2025-11-15", "Proclamação da República"],
  ["2025-11-20", "Consciência Negra"],
  ["2025-12-25", "Natal"],
  ["2026-01-01", "Confraternização Universal"],
  ["2026-02-16", "Carnaval"],
  ["2026-02-17", "Carnaval"],
  ["2026-03-19", "São José (CE)"],
  ["2026-04-03", "Sexta-feira Santa"],
  ["2026-04-13", "Aniversário de Fortaleza"],
  ["2026-04-21", "Tiradentes"],
  ["2026-05-01", "Dia do Trabalho"],
  ["2026-06-04", "Corpus Christi"],
  ["2026-09-07", "Independência"],
  ["2026-10-12", "Nossa Senhora Aparecida"],
  ["2026-11-02", "Finados"],
  ["2026-11-15", "Proclamação da República"],
  ["2026-11-20", "Consciência Negra"],
  ["2026-12-25", "Natal"],
]);
export const yearHasHolidays = (y: number) =>
  [...HOLIDAYS.keys()].some((d) => d.startsWith(String(y)));

const FIRST = [
  "Ana",
  "Bruno",
  "Carla",
  "Diego",
  "Elisa",
  "Fábio",
  "Gabriela",
  "Heitor",
  "Íris",
  "João",
  "Karen",
  "Lucas",
  "Marina",
  "Nicolas",
  "Olívia",
  "Paulo",
  "Queila",
  "Rafael",
  "Sabrina",
  "Tiago",
  "Úrsula",
  "Vinícius",
  "Wanda",
  "Xavier",
  "Yara",
  "Zeca",
  "Laura",
];
const LAST = [
  "Albuquerque",
  "Barros",
  "Campos",
  "Dantas",
  "Esteves",
  "Freitas",
  "Gomes",
  "Holanda",
  "Inácio",
  "Jardim",
  "Lima",
  "Moura",
  "Nogueira",
  "Oliveira",
  "Pinheiro",
  "Queiroz",
  "Rocha",
  "Sales",
  "Teixeira",
  "Uchôa",
  "Vale",
  "Xavier",
  "Barreto",
  "Cavalcante",
  "Diniz",
  "Façanha",
  "Girão",
];

// Quantos vendedores vendem e quantos são de licitação, por empresa.
const PROFILE: Record<
  string,
  {
    active: number;
    licitacao: number;
    monthly: number;
    notes: [number, number];
    sat: number;
    spread: [number, number];
  }
> = {
  "mag-filial": {
    active: 13,
    licitacao: 2,
    monthly: 650_000,
    notes: [230, 270],
    sat: 0.06,
    spread: [0.8, 1.2],
  },
  "uni-design": {
    active: 4,
    licitacao: 0,
    monthly: 25_000,
    notes: [18, 28],
    sat: 0.15,
    spread: [0.8, 1.2],
  },
  ergooffice: {
    active: 1,
    licitacao: 0,
    monthly: 900_000,
    notes: [10, 15],
    sat: 0,
    spread: [0.8, 1.2],
  },
  expert: { active: 1, licitacao: 0, monthly: 0, notes: [3, 12], sat: 0, spread: [0, 0] },
  "mag-matriz": { active: 0, licitacao: 0, monthly: 0, notes: [0, 0], sat: 0, spread: [0, 0] },
};

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Invoice {
  id: string;
  companyId: string;
  sellerId: string;
  customerId: string;
  date: string;
  amount: Money;
}
export interface Quote {
  id: string;
  companyId: string;
  sellerId: string;
  customer: string;
  amount: Money;
  openedAt: string;
}
export interface IdleProduct {
  id: string;
  companyId: string;
  name: string;
  amount: Money;
  idleDays: number;
}
export interface TargetRow {
  companyId: string;
  month: string;
  channel: Channel | null;
  sellerId: string | null;
  targets: TargetSet;
}

export interface Dataset {
  sellers: Seller[];
  invoices: Invoice[];
  orders: (OpenOrder & { companyId: string })[];
  quotes: Quote[];
  idleProducts: IdleProduct[];
  targets: TargetRow[];
  customerNames: Map<string, string>;
}

export function buildDataset(): Dataset {
  const r = rng(20261118);
  const sellers: Seller[] = [];
  const invoices: Invoice[] = [];
  const customerNames = new Map<string, string>();
  for (const c of COMPANIES) {
    const p = PROFILE[c.id]!;
    for (let i = 0; i < 27; i++) {
      sellers.push({
        id: `${c.id}-v${String(i + 1).padStart(2, "0")}`,
        companyId: c.id,
        name: `${FIRST[i]} ${LAST[(i * 7) % LAST.length]}`,
        channel: i >= p.active - p.licitacao && i < p.active ? "licitacao" : "varejo",
        active: i < 22,
      });
    }
    const cust = Array.from(
      { length: c.id === "mag-filial" ? 1600 : 120 },
      (_, k) => `${c.id}-c${k + 1}`,
    );
    cust.forEach((id, k) =>
      customerNames.set(id, `Cliente ${String(k + 1).padStart(4, "0")} ${c.slug.toUpperCase()}`),
    );
    const activeSellers = sellers.filter((s) => s.companyId === c.id).slice(0, p.active);
    if (!activeSellers.length) continue;
    const shares = activeSellers.map((_, k) => 1 / (k + 1.6));
    const shareSum = shares.reduce((a, b) => a + b, 0);
    for (let mi = 0; mi < 13; mi++) {
      const month = addMonths(HISTORY_START, mi);
      let total: number;
      if (c.id === "expert") total = 5_000 + r() * 245_000;
      else total = p.monthly * (p.spread[0] + r() * (p.spread[1] - p.spread[0]));
      const days = daysOfMonth(month).filter(
        (d) => d <= AS_OF && !HOLIDAYS.has(d) && weekday(d) !== 0,
      );
      if (!days.length) continue;
      const allDays = daysOfMonth(month).filter((d) => !HOLIDAYS.has(d) && weekday(d) !== 0);
      const portion = days.length / allDays.length;
      const notes = Math.max(
        1,
        Math.round((p.notes[0] + r() * (p.notes[1] - p.notes[0])) * portion),
      );
      const monthTotal = total * portion;
      const sats = days.filter((d) => weekday(d) === 6),
        weekdays = days.filter((d) => weekday(d) !== 6);
      const raw = Array.from({ length: notes }, () => 0.3 + r());
      const rawSum = raw.reduce((a, b) => a + b, 0);
      raw.forEach((w, n) => {
        const isSat = sats.length > 0 && r() < p.sat;
        const pool = isSat ? sats : weekdays.length ? weekdays : sats;
        const date = pool[Math.floor(r() * pool.length)]!;
        let pick = r() * shareSum,
          si = 0;
        while (pick > shares[si]! && si < shares.length - 1) {
          pick -= shares[si]!;
          si++;
        }
        const seller = activeSellers[si]!;
        // Vendedor 6 da Mag Filial está parado há mais de 5 dias úteis (alerta).
        const idle = seller.id === "mag-filial-v06" && date > "2026-11-09";
        invoices.push({
          id: `${c.id}-nf-${month}-${n}`,
          companyId: c.id,
          sellerId: idle ? activeSellers[0]!.id : seller.id,
          customerId: cust[Math.floor(r() * r() * cust.length)]!,
          date,
          amount: Math.round(((monthTotal * w) / rawSum) * 100) / 100,
        });
      });
    }
  }
  invoices.sort((a, b) => a.date.localeCompare(b.date));

  // Carteira: Mag Filial 8 pedidos (R$ 289.680), 5 com previsão vencida (R$ 276.610).
  const mf = (n: number) => `mag-filial-v${String(n).padStart(2, "0")}`;
  const orders: Dataset["orders"] = [
    {
      id: "PV-4101",
      sellerId: mf(1),
      customer: "Construtora Litoral",
      amount: 98_400,
      openedAt: "2026-10-02",
      expectedDate: "2026-10-28",
    },
    {
      id: "PV-4117",
      sellerId: mf(2),
      customer: "Clínica Aldeota",
      amount: 61_250,
      openedAt: "2026-10-09",
      expectedDate: "2026-11-04",
    },
    {
      id: "PV-4122",
      sellerId: mf(3),
      customer: "Escritório Meireles",
      amount: 54_960,
      openedAt: "2026-10-20",
      expectedDate: "2026-11-10",
    },
    {
      id: "PV-4130",
      sellerId: mf(12),
      customer: "Prefeitura de Caucaia",
      amount: 38_000,
      openedAt: "2026-10-27",
      expectedDate: "2026-11-13",
    },
    {
      id: "PV-4136",
      sellerId: mf(4),
      customer: "Coworking Centro",
      amount: 24_000,
      openedAt: "2026-11-03",
      expectedDate: "2026-11-15",
    },
    {
      id: "PV-4140",
      sellerId: mf(1),
      customer: "Hotel Beira-Mar",
      amount: 6_870,
      openedAt: "2026-11-11",
      expectedDate: "2026-11-27",
    },
    {
      id: "PV-4143",
      sellerId: mf(5),
      customer: "Faculdade Norte",
      amount: 4_300,
      openedAt: "2026-10-01",
      expectedDate: null,
    },
    {
      id: "PV-4146",
      sellerId: mf(2),
      customer: "Loja Varjota",
      amount: 1_900,
      openedAt: "2026-11-16",
      expectedDate: "2026-12-10",
    },
  ].map((o) => ({ ...o, companyId: "mag-filial" }));
  orders.push(
    {
      id: "PV-9001",
      companyId: "uni-design",
      sellerId: "uni-design-v01",
      customer: "Studio Dionísio",
      amount: 3_200,
      openedAt: "2026-11-12",
      expectedDate: "2026-11-25",
    },
    {
      id: "PV-7001",
      companyId: "ergooffice",
      sellerId: "ergooffice-v01",
      customer: "Banco Regional",
      amount: 210_000,
      openedAt: "2026-10-30",
      expectedDate: "2026-11-24",
    },
  );

  const quotes: Quote[] = [];
  const quoteSpec: [string, number, number, number][] = [
    ["mag-filial", 58, 540_000, 13],
    ["uni-design", 24, 1_120_000, 4],
    ["ergooffice", 1, 357_000, 1],
    ["expert", 26, 24_000, 1],
  ];
  for (const [cid, count, amount, act] of quoteSpec) {
    const raw = Array.from({ length: count }, () => 0.2 + r());
    const sum = raw.reduce((a, b) => a + b, 0);
    raw.forEach((w, k) =>
      quotes.push({
        id: `ORC-${cid}-${k + 1}`,
        companyId: cid,
        sellerId: `${cid}-v${String((k % act) + 1).padStart(2, "0")}`,
        customer: `Prospect ${String(k + 1).padStart(3, "0")}`,
        amount: Math.round(((amount * w) / sum) * 100) / 100,
        openedAt: addDays(AS_OF, -Math.floor(r() * 60)),
      }),
    );
  }

  const idleProducts: IdleProduct[] = [
    "Cadeira Diretor Tela",
    "Mesa Plataforma 4 lugares",
    "Armário Alto 2 portas",
    "Gaveteiro Volante",
    "Estação em L 160",
    "Poltrona Espera",
  ].flatMap((name, k) =>
    COMPANIES.filter((c) => c.id !== "mag-matriz").map((c) => ({
      id: `${c.id}-p${k}`,
      companyId: c.id,
      name,
      amount: 4_000 + k * 3_150,
      idleDays: 95 + k * 21,
    })),
  );

  // Metas
  const T = (b: number | null, a: number | null, ch: number | null): TargetSet => ({
    BASE: b,
    ACTIVE: a,
    CHALLENGE: ch,
  });
  const targets: TargetRow[] = [
    {
      companyId: "mag-filial",
      month: CURRENT_MONTH,
      channel: "varejo",
      sellerId: null,
      targets: T(500_000, 600_000, 700_000),
    },
    {
      companyId: "mag-filial",
      month: CURRENT_MONTH,
      channel: "licitacao",
      sellerId: null,
      targets: T(80_000, 100_000, 130_000),
    },
    {
      companyId: "expert",
      month: CURRENT_MONTH,
      channel: null,
      sellerId: null,
      targets: T(null, 150_000, null),
    },
  ];
  const magActive = [
    110_000, 90_000, 80_000, 70_000, 60_000, 50_000, 45_000, 40_000, 25_000, 15_000, 5_000, 50_000,
    40_000,
  ]; // soma 680.000
  magActive.forEach((a, k) => {
    const seller = mf(k + 1);
    targets.push({
      companyId: "mag-filial",
      month: CURRENT_MONTH,
      channel: null,
      sellerId: seller,
      targets: T(Math.round(a * 0.85), a, Math.round(a * 1.15)),
    });
    for (let m = 3; m <= 9; m++)
      targets.push({
        companyId: "mag-filial",
        month: `2026-${String(m).padStart(2, "0")}`,
        channel: null,
        sellerId: seller,
        targets: T(Math.round(a * 0.8), Math.round(a * 0.92), Math.round(a * 1.1)),
      });
  });
  [12_000, 8_000, 6_000, 4_000].forEach((a, k) =>
    targets.push({
      companyId: "uni-design",
      month: CURRENT_MONTH,
      channel: null,
      sellerId: `uni-design-v0${k + 1}`,
      targets: T(Math.round(a * 0.85), a, Math.round(a * 1.15)),
    }),
  );

  return { sellers, invoices, orders, quotes, idleProducts, targets, customerNames };
}
