import test from "node:test";
import assert from "node:assert/strict";
import { withAdminAccess } from "../src/lib/admin-access.mjs";

test("configured admin access matches exact emails and follows config changes", () => {
  const original = process.env.adminEmail;
  try {
    const user = { email: " Admin@example.com ", roles: [{ name: "cashier", permissions: [] }] };
    process.env.adminEmail = "other@example.com; ADMIN@example.com, third@example.com";
    const admin = withAdminAccess(user);
    assert.deepEqual(admin.roles.map((role) => role.name), ["cashier", "super_admin"]);
    assert.equal(user.roles.length, 1);
    assert.equal(withAdminAccess(admin).roles.length, 2);
    assert.equal(withAdminAccess({ email: "third@example.com" }).roles[0].name, "super_admin");
    const unrelated = { email: "notadmin@example.com", roles: [] };
    assert.equal(withAdminAccess(unrelated), unrelated);
    process.env.adminEmail = "";
    assert.equal(withAdminAccess(user), user);
    const empty = { email: "", roles: [] };
    assert.equal(withAdminAccess(empty), empty);
  } finally {
    if (original === undefined) delete process.env.adminEmail;
    else process.env.adminEmail = original;
  }
});
