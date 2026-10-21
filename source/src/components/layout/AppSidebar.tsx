import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Building2, ChevronsUpDown, LogOut, Settings, UserRound } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NAV_GROUPS } from "./nav";
import { appContextQuery } from "@/lib/queries";
import { hasPermission, ROLE_LABELS } from "@/domain/rbac";
import { supabase } from "@/integrations/supabase/client";
import { useGlobalFilters } from "@/hooks/use-filters";
import { BrandMark } from "@/components/brand/BrandMark";

export function AppSidebar() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const { resolved, setFilters } = useGlobalFilters();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const company = ctx.companies.find((c) => c.id === resolved?.company);
  const initials = (ctx.user.fullName ?? ctx.user.email ?? "?").slice(0, 2).toUpperCase();

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 px-1.5">
          <BrandMark className="size-7 shrink-0" />
          <div className="flex flex-col leading-none group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight text-white">BIOMIE</span>
            <span className="text-[11px] text-sidebar-foreground/70">Analytics Platform</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(
            (i) => !i.permission || hasPermission(ctx.roles, i.permission),
          );
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu>
                {items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname.startsWith(item.to)}
                      tooltip={item.label}
                    >
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                        {!item.ready && (
                          <span className="ml-auto text-[10px] font-medium text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
                            em breve
                          </span>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip="Empresa">
                  <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-primary">
                    <Building2 className="size-4" />
                  </div>
                  <div className="flex min-w-0 flex-col text-left leading-tight">
                    <span className="text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-sidebar-foreground/60">
                      Empresa
                    </span>
                    <span className="truncate text-sm font-medium">{company?.name ?? "—"}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/60" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-64">
                <DropdownMenuLabel>Alternar empresa</DropdownMenuLabel>
                {ctx.companies.map((c) => (
                  <DropdownMenuItem key={c.id} onClick={() => setFilters({ company: c.id })}>
                    <span className="truncate">{c.name}</span>
                    {c.isDemo && (
                      <span className="ml-auto rounded bg-demo px-1.5 py-0.5 text-[10px] font-medium text-demo-foreground">
                        DEMO
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip="Conta">
                  <div className="flex size-8 items-center justify-center rounded-full bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
                    {initials}
                  </div>
                  <div className="flex min-w-0 flex-col text-left leading-tight">
                    <span className="truncate text-sm font-medium">
                      {ctx.user.fullName ?? ctx.user.email}
                    </span>
                    <span className="truncate text-xs text-sidebar-foreground/60">
                      {ctx.roles.map((r) => ROLE_LABELS[r]).join(", ")}
                    </span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-56">
                <DropdownMenuLabel className="truncate">{ctx.user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/minha-conta">
                    <UserRound className="size-4" /> Minha conta
                  </Link>
                </DropdownMenuItem>
                {hasPermission(ctx.roles, "admin:manage") && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin">
                      <Settings className="size-4" /> Configurações
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={signOut}>
                  <LogOut className="size-4" /> Sair
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
