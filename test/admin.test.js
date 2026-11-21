import assert from "node:assert/strict";
import test from "node:test";
import app from "../src/app.js";
import {
  loadAdminOverview,
  parseAdminPagination,
  parseAdminServiceId,
  parseAdminServiceQuery,
  parseAdminServiceUpdate,
  parseAdminUserBlockInput,
  parseAdminUserId,
  parseAdminUserQuery,
} from "../src/routes/admin.js";
import { requireRole } from "../src/middleware/requireRole.js";

test("admin list queries validate pagination and escape search terms", () => {
  assert.deepEqual(parseAdminPagination({ page: "2", pageSize: "50" }), {
    page: 2,
    pageSize: 50,
  });
  assert.throws(() => parseAdminPagination({ page: "0" }), { statusCode: 400 });
  assert.throws(() => parseAdminPagination({ pageSize: "101" }), { statusCode: 400 });

  const users = parseAdminUserQuery({
    search: "name.+",
    role: "vendor",
  });
  assert.equal(users.filter.role, "vendor");
  assert.equal(users.filter.$or[0].name.source, "name\\.\\+");
  assert.throws(
    () => parseAdminUserQuery({ role: "superadmin" }),
    { statusCode: 400 },
  );

  const services = parseAdminServiceQuery({
    search: "photo (Dhaka)",
    status: "pending",
  });
  assert.equal(services.filter.status, "pending");
  assert.equal(services.filter.$or[0].serviceName.source, "photo \\(Dhaka\\)");
  assert.throws(
    () => parseAdminServiceQuery({ status: "deleted" }),
    { statusCode: 400 },
  );
});

test("admin user and service mutations accept only authorized fields", () => {
  assert.deepEqual(parseAdminUserBlockInput({ isBlocked: true }), {
    isBlocked: true,
  });
  assert.throws(
    () => parseAdminUserBlockInput({ isBlocked: "true" }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseAdminUserBlockInput({ isBlocked: false, role: "admin" }),
    { statusCode: 400 },
  );

  assert.deepEqual(parseAdminServiceUpdate({ status: "approved" }), {
    status: "approved",
  });
  assert.deepEqual(parseAdminServiceUpdate({ isActive: false }), {
    isActive: false,
  });
  assert.throws(
    () => parseAdminServiceUpdate({ vendorId: "another-user" }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseAdminServiceUpdate({ status: "active" }),
    { statusCode: 400 },
  );
  assert.throws(() => parseAdminUserId("../users"), { statusCode: 400 });
  assert.equal(
    parseAdminServiceId("507f1f77bcf86cd799439011").toHexString(),
    "507f1f77bcf86cd799439011",
  );
});

test("admin overview counts users, services, pending services, and transactions", async () => {
  const calls = [];
  const database = {
    collection(name) {
      return {
        countDocuments: async (filter) => {
          calls.push({ name, filter });
          if (name === "users" && filter.role === "vendor") return 3;
          if (name === "users" && filter.role === "customer") return 8;
          if (name === "users") return 12;
          if (filter.status === "pending") return 2;
          if (name === "services") return 5;
          return 4;
        },
      };
    },
  };

  assert.deepEqual(await loadAdminOverview(database), {
    totalUsers: 12,
    totalVendors: 3,
    totalCustomers: 8,
    totalServices: 5,
    pendingServices: 2,
    totalTransactions: 4,
  });
  assert.deepEqual(
    calls.map(({ name, filter }) => [name, filter]),
    [
      ["users", {}],
      ["users", { role: "vendor" }],
      ["users", { role: "customer" }],
      ["services", {}],
      ["services", { status: "pending" }],
      ["transactions", {}],
    ],
  );
});

test("admin endpoints reject requests without a bearer token", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  test("admin middleware rejects other roles and allows admins", () => {
    const adminOnly = requireRole("admin");
    adminOnly(
      { user: { role: "vendor" } },
      {},
      (error) => assert.equal(error.statusCode, 403),
    );

    let nextCalled = false;
    adminOnly(
      { user: { role: "admin" } },
      {},
      (error) => {
        assert.equal(error, undefined);
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const { port } = server.address();
  for (const path of [
    "/api/v1/admin/overview",
    "/api/v1/admin/users",
    "/api/v1/admin/services",
    "/api/v1/admin/transactions",
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 401, path);
  }
});
