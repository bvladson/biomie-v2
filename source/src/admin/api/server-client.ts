/** AdminApi ligado às funções de servidor do BIOMIE (as regras são aplicadas no banco). */
import type { AdminApi } from "./contract";
import * as fn from "@/lib/admin-users.functions";

const done = () => undefined;

export const serverAdminApi: AdminApi = {
  me: () => fn.adminMe(),
  listUsers: (filter) => fn.adminListUsers({ data: filter }),
  getUser: (id) => fn.adminGetUser({ data: { id } }),
  createUser: (input) => fn.adminCreateUser({ data: input }),
  updateProfile: (id, patch) => fn.adminUpdateProfile({ data: { id, patch } }),
  updateAccess: (id, access) => fn.adminUpdateAccess({ data: { id, access } }),
  setRoles: (id, roles) => fn.adminUpdateAccess({ data: { id, access: { roles } } }),
  setCompanies: (id, companyIds) => fn.adminUpdateAccess({ data: { id, access: { companyIds } } }),
  setSellers: (id, sellerIds) => fn.adminUpdateAccess({ data: { id, access: { sellerIds } } }),
  setManagedTeams: (id, managedTeamIds) =>
    fn.adminUpdateAccess({ data: { id, access: { managedTeamIds } } }),
  setPermissions: (id, permissions) =>
    fn.adminUpdateAccess({ data: { id, access: { permissions } } }),
  issueAccess: (id, delivery) => fn.adminIssueAccess({ data: { id, delivery } }),
  setBlocked: (id, blocked, reason) => fn.adminSetBlocked({ data: { id, blocked, reason } }),
  signOutEverywhere: (id) => fn.adminSignOutEverywhere({ data: { id } }).then(done),
  deleteUser: (id, confirmEmail) => fn.adminDeleteUser({ data: { id, confirmEmail } }).then(done),
  listCompanies: () => fn.adminListCompanies(),
  renameCompany: (id, name) => fn.adminRenameCompany({ data: { id, name } }),
  listSellers: (companyId) => fn.adminListSellers({ data: { companyId } }),
  listTeams: (companyId) => fn.adminListTeams({ data: { companyId } }),
  listHolidays: (year) => fn.adminListHolidays({ data: { year } }),
  saveHoliday: (holiday) => fn.adminSaveHoliday({ data: holiday }),
  deleteHoliday: (id) => fn.adminDeleteHoliday({ data: { id } }).then(done),
  importHolidays: (rows) => fn.adminImportHolidays({ data: { rows } }),
  listAudit: (filter) => fn.adminListAudit({ data: filter }),
  updateMyName: (fullName) => fn.myUpdateName({ data: { fullName } }),
  changeMyPassword: (current, next) => fn.myChangePassword({ data: { current, next } }).then(done),
  listMySessions: () => fn.myListSessions(),
  signOutOtherSessions: () => fn.mySignOutOtherSessions().then(done),
};
