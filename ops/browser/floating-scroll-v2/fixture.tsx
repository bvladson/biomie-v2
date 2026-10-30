import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PositionsPage } from "@/estoque/pages/PositionsPage";
import { StockContext } from "@/estoque/lib/hooks";
import { GlobalFloatingTableScroll } from "@/components/layout/GlobalFloatingTableScroll";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import "@/styles.css";
import "./fixture.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const context = { companyId: "all", window: "12m" as const,
  setCompanyId() {}, setWindow() {} };

function PanelTable({ fit = false }: { fit?: boolean }) {
  return <Table className={fit ? "fixture-fit-table" : "fixture-panel-table"}>
    <TableHeader><TableRow>{["Produto", "Curva", "Custo", "Reservado", "Pendente"].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{Array.from({ length: 82 }, (_, row) => <TableRow key={row}>{Array.from({ length: 5 }, (_, column) => <TableCell key={column}>Produto sintético {row + 1} · {column + 1}</TableCell>)}</TableRow>)}</TableBody>
  </Table>;
}

function Fixture() {
  const [mounted, setMounted] = useState(true);
  const [controller, setController] = useState(true);
  const [fit, setFit] = useState(false);
  return <QueryClientProvider client={queryClient}>
    <StockContext.Provider value={context}>
      {controller && <GlobalFloatingTableScroll />}
      <aside className="fixture-sidebar"><strong>BIOMIE</strong><p>Analytics Platform</p><nav>Produtos<br />Estoque<br />Financeiro</nav><small>Dados sintéticos · teste local</small></aside>
      <div className="fixture-shell">
        <header className="fixture-header"><strong>BIOMIE</strong><div>Empresa: demonstração local · Período: Outubro / 2026</div></header>
        <main className="fixture-content">
          <div className="fixture-actions">
            <button id="toggle-page" onClick={() => setMounted(value => !value)}>Remontar página React</button>
            <button id="toggle-controller" onClick={() => setController(value => !value)}>Alternar controlador</button>
            <button id="fit-table" onClick={() => setFit(value => !value)}>Alternar tabela sem overflow</button>
            <Sheet><SheetTrigger asChild><button id="open-sheet">Abrir Produto 360</button></SheetTrigger>
              <SheetContent className="fixture-sheet"><SheetHeader><SheetTitle>Produto 360</SheetTitle><SheetDescription>Fixture local com Table e Sheet reais.</SheetDescription></SheetHeader>
                <div id="fixture-sheet-body"><PanelTable /></div><footer id="fixture-sheet-footer">Ações do painel</footer>
              </SheetContent>
            </Sheet>
          </div>
          <section id="positions-slot" className={fit ? "fixture-force-fit" : undefined}>
            {mounted ? <PositionsPage /> : <p id="unmounted">Outra tela: tabela desmontada pelo React.</p>}
          </section>
          <section id="fit-panel" hidden={!fit}><PanelTable fit /></section>
        </main>
      </div>
    </StockContext.Provider>
  </QueryClientProvider>;
}

const zoom = Number(new URLSearchParams(location.search).get("zoom") || 1);
document.documentElement.style.zoom = String(zoom);
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
