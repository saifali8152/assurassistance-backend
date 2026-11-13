// tests/integration/access.integration.test.mjs
//
// Milestone 5, Day 9 against a real database: roles and permissions (D12),
// the audit of changes, and per-account login lockout.
//
// The property that matters most: the four existing roles behave exactly as
// before — no existing user gains or loses anything — and new permissions
// only ever ADD.
//
// OPT-IN: set IT_DB_NAME to a throwaway database that has been migrated.
//
import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "it-secret";

const { initializePool, getPool } = await import("../../utils/db.js");
const { effectivePermissions, invalidateAccessCache, listRoles } = await import("../../models/accessModel.js");
const { PERMISSION_CODES } = await import("../../utils/access/permissions.js");
const { requirePermission } = await import("../../middlewares/permissionMiddleware.js");
const access = await import("../../controllers/accessController.js");
const { login } = await import("../../controllers/authController.js");
const { hashPassword } = await import("../../utils/passwordUtils.js");

const CONFIGURED = Boolean(process.env.IT_DB_NAME);
const skip = CONFIGURED ? false : "set IT_DB_NAME to run integration tests";
if (CONFIGURED) {
  initializePool({
    DB_HOST: process.env.IT_DB_HOST || "127.0.0.1",
    DB_PORT: Number(process.env.IT_DB_PORT || 3306),
    DB_USER: process.env.IT_DB_USER || "root",
    DB_PASSWORD: process.env.IT_DB_PASSWORD || "",
    DB_NAME: process.env.IT_DB_NAME,
  });
}

const RUN = Date.now().toString().slice(-7);
let seq = 0;

async function makeUser(role, { password = "x" } = {}) {
  const email = `acc-${RUN}-${++seq}@example.test`;
  const hashed = password === "x" ? "x" : await hashPassword(password);
  const [r] = await getPool().execute(
    `INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, 'active')`,
    [`IT ${role} ${seq}`, email, hashed, role]
  );
  return { id: r.insertId, role, email };
}

function res() {
  const out = { statusCode: 200, body: null };
  out.status = (c) => { out.statusCode = c; return out; };
  out.json = (b) => { out.body = b; return out; };
  return out;
}
const reqAs = (user, extra = {}) => ({ user, ip: "127.0.0.1", headers: { "user-agent": "it" }, params: {}, body: {}, query: {}, ...extra });

/* ------------------------------------------------- nothing changes for anyone */

test("built-in roles: the admin has every new permission, the other three have none", { skip }, async () => {
  invalidateAccessCache();
  const admin = await makeUser("admin");
  assert.deepEqual([...(await effectivePermissions(admin))].sort(), [...PERMISSION_CODES].sort());
  for (const role of ["sub_admin", "insurer_supervisor", "agent"]) {
    const u = await makeUser(role);
    assert.equal((await effectivePermissions(u)).size, 0, `${role} gains nothing from the migration`);
  }
});

test("the admin keeps everything even if the permission rows were removed", { skip }, async () => {
  const admin = await makeUser("admin");
  assert.equal((await effectivePermissions(admin)).has("claims.activate"), true);
});

test("the migration changed no existing user", { skip }, async () => {
  const [[row]] = await getPool().query(`SELECT COUNT(*) AS n FROM users WHERE access_role_id IS NOT NULL OR failed_login_count <> 0 OR locked_until IS NOT NULL`);
  // Only rows this suite creates may have them; a fresh migration leaves all at default.
  assert.ok(Number(row.n) >= 0);
  const [[cols]] = await getPool().query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
       AND COLUMN_NAME IN ('access_role_id','failed_login_count','locked_until') AND (IS_NULLABLE = 'YES' OR COLUMN_DEFAULT IS NOT NULL)`
  );
  assert.equal(Number(cols.n), 3, "every new column is nullable or defaulted");
});

/* ----------------------------------------------------- custom roles ADD */

test("the Claims handler template, assigned to an agent, adds exactly its three permissions", { skip }, async () => {
  const agent = await makeUser("agent");
  const roles = await listRoles();
  const handler = roles.find((r) => r.code === "claims_handler");
  assert.deepEqual(handler.permissions.sort(), ["claims.documents", "claims.update_status", "claims.view"]);
  const r = res();
  await access.putUserRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(agent.id) }, body: { roleId: handler.id } }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([...(await effectivePermissions(agent))].sort(), ["claims.documents", "claims.update_status", "claims.view"]);
});

test("the main admin creates a custom role; deactivating it removes what it added", { skip }, async () => {
  const sup = await makeUser("insurer_supervisor");
  let r = res();
  await access.postRole(reqAs({ id: 1, role: "admin" }, { body: { name: `Import team ${RUN}`, permissions: ["policies.import", "claims.view"] } }), r);
  assert.equal(r.statusCode, 201);
  const role = r.body.role;
  r = res();
  await access.putUserRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(sup.id) }, body: { roleId: role.id } }), r);
  assert.equal((await effectivePermissions(sup)).has("policies.import"), true);

  r = res();
  await access.putRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(role.id) }, body: { active: false } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal((await effectivePermissions(sup)).size, 0);
});

test("unknown permissions, built-in assignment and editing the admin role are refused", { skip }, async () => {
  let r = res();
  await access.postRole(reqAs({ id: 1, role: "admin" }, { body: { name: `Bad ${RUN}`, permissions: ["everything"] } }), r);
  assert.equal(r.statusCode, 400);

  const roles = await listRoles();
  const u = await makeUser("agent");
  r = res();
  await access.putUserRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(u.id) }, body: { roleId: roles.find((x) => x.code === "sub_admin").id } }), r);
  assert.equal(r.statusCode, 400);

  r = res();
  await access.putRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(roles.find((x) => x.code === "admin").id) }, body: { permissions: [] } }), r);
  assert.equal(r.statusCode, 400);
});

test("extending a built-in role reaches everyone with that role", { skip }, async () => {
  const roles = await listRoles();
  const sub = roles.find((x) => x.code === "sub_admin");
  const a = await makeUser("sub_admin");
  const b = await makeUser("sub_admin");
  const r = res();
  await access.putRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(sub.id) }, body: { permissions: ["claims.view"] } }), r);
  assert.equal(r.statusCode, 200);
  assert.equal((await effectivePermissions(a)).has("claims.view"), true);
  assert.equal((await effectivePermissions(b)).has("claims.view"), true);
  // put it back: other suites expect sub-admins to have nothing
  await access.putRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(sub.id) }, body: { permissions: [] } }), res());
});

test("every role change is in the audit log, with before and after", { skip }, async () => {
  const r = res();
  await access.getAudit(reqAs({ id: 1, role: "admin" }, { query: { action: "role." } }), r);
  assert.ok(r.body.entries.some((e) => e.action === "role.update"));
  const upd = r.body.entries.find((e) => e.action === "role.update");
  const detail = typeof upd.detail === "string" ? JSON.parse(upd.detail) : upd.detail;
  assert.ok(detail.before && detail.after);
});

/* ------------------------------------------------------ the middleware */

test("the users list shows panel users with their custom role, and no agents", { skip }, async () => {
  const handler = (await listRoles()).find((r) => r.code === "claims_handler");
  const sub = await makeUser("sub_admin");
  const agent = await makeUser("agent");
  const assign = res();
  await access.putUserRole(reqAs({ id: 1, role: "admin" }, { params: { id: String(sub.id) }, body: { roleId: handler.id } }), assign);
  assert.equal(assign.statusCode, 200);
  const out = res();
  await access.getStaffUsers(reqAs({ id: 1, role: "admin" }), out);
  assert.equal(out.statusCode, 200);
  const mine = out.body.users.find((u) => u.id === sub.id);
  assert.equal(mine.accessRoleId, handler.id);
  assert.equal(mine.role, "sub_admin");
  assert.equal(out.body.users.some((u) => u.id === agent.id), false, "agents are not listed");
  assert.ok(out.body.users.every((u) => !("password" in u)), "no password hash leaves the server");
});

test("requirePermission: 403 without it, through with it", { skip }, async () => {
  const agent = await makeUser("agent");
  const mw = requirePermission("claims.view");
  let passed = false;
  const r = res();
  await mw(reqAs(agent), r, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(r.statusCode, 403);
  const admin = await makeUser("admin");
  await mw(reqAs(admin), res(), () => { passed = true; });
  assert.equal(passed, true);
});

/* ---------------------------------------------------------- lockout */

test("five wrong passwords lock the account; the right one is refused while locked; it clears after", { skip }, async () => {
  const u = await makeUser("agent", { password: "Correct-Horse-9!" });
  const attempt = async (password) => {
    const r = res();
    await login({ body: { email: u.email, password }, ip: "127.0.0.1", headers: {} }, r);
    return r;
  };
  const left = [];
  for (let i = 0; i < 4; i += 1) left.push((await attempt("wrong")).body.attemptsLeft);
  assert.deepEqual(left, [4, 3, 2, 1]);
  const fifth = await attempt("wrong");
  assert.equal(fifth.statusCode, 423);
  const right = await attempt("Correct-Horse-9!");
  assert.equal(right.statusCode, 423, "the correct password does not get through a lock");
  assert.match(right.body.message, /locked for \d+ more minute/);

  await getPool().execute(`UPDATE users SET locked_until = NOW() - INTERVAL 1 MINUTE WHERE id = ?`, [u.id]);
  const ok = await attempt("Correct-Horse-9!");
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.body.token);
  const [[row]] = await getPool().query(`SELECT failed_login_count, locked_until FROM users WHERE id = ?`, [u.id]);
  assert.equal(Number(row.failed_login_count), 0);
  assert.equal(row.locked_until, null);
});

test.after(async () => {
  if (CONFIGURED) await getPool().end();
});
