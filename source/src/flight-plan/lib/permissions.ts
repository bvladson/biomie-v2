/**
 * Dicas de permissão para mostrar ou esconder botões. Quem decide de verdade é o banco
 * (flight_plan_internal, migração 0050); estas regras só repetem as de lá para a tela.
 */
import type { Me } from "../api/contract";

/** Admin, Diretoria e Super admin: metas da empresa, todos os vendedores, alertas e decisões. */
export const isManager = (me: Me) =>
  me.roles.some((r) => r === "SUPER_ADMIN" || r === "ADMIN" || r === "DIRETORIA");
const isGestor = (me: Me) => me.roles.includes("GESTOR");
const isSeller = (me: Me) => me.roles.includes("VENDEDOR") && !!me.sellerId;
export const manages = (me: Me, sellerId: string) =>
  isGestor(me) && me.managedSellerIds.includes(sellerId);

/** Compromisso do mês: Admin, Diretoria, o Gestor do vendedor ou o próprio vendedor. */
export const canEditCommit = (me: Me, sellerId: string) =>
  isManager(me) || manages(me, sellerId) || me.sellerId === sellerId;

/** Ciente / Resolvido: Admin e Diretoria; Gestor nos vendedores dele e no conjunto que ele vê. */
export const canManageAlert = (me: Me, sellerId: string | null) =>
  isManager(me) || (isGestor(me) && (sellerId === null || me.managedSellerIds.includes(sellerId)));

/** Criar ação corretiva: quem gerencia o alerta, ou o próprio vendedor no alerta dele. */
export const canCreateAlertAction = (me: Me, sellerId: string | null) =>
  canManageAlert(me, sellerId) || (isSeller(me) && sellerId !== null && me.sellerId === sellerId);

export const canCreateInitiative = (me: Me) => isManager(me) || isGestor(me) || isSeller(me);

export function canEditInitiative(me: Me, i: { sellerIds: string[]; ownerUserId: string }) {
  if (isManager(me)) return true;
  const ownerSeller = i.ownerUserId.startsWith("seller:") ? i.ownerUserId.slice(7) : null;
  if (
    isGestor(me) &&
    i.sellerIds.every((id) => me.managedSellerIds.includes(id)) &&
    (ownerSeller === null || me.managedSellerIds.includes(ownerSeller))
  )
    return true;
  return (
    isSeller(me) &&
    i.sellerIds.every((id) => id === me.sellerId) &&
    (i.ownerUserId === `user:${me.userId}` || ownerSeller === me.sellerId)
  );
}

/** Decisões da reunião semanal: Admin, Diretoria e Gestor. */
export const canDecide = (me: Me) => isManager(me) || isGestor(me);
