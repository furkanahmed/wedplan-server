import { Router } from "express";
import { ObjectId } from "mongodb";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";

const userProjection = {
  name: 1,
  email: 1,
  role: 1,
  isBlocked: 1,
  businessName: 1,
  createdAt: 1,
};
const userDetailProjection = {
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  isBlocked: 1,
  businessName: 1,
  subscriptionPlan: 1,
  subscriptionExpiresAt: 1,
  createdAt: 1,
};
const serviceProjection = {
  serviceName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  vendorId: 1,
  status: 1,
  isActive: 1,
  createdAt: 1,
};
const transactionProjection = {
  vendorId: 1,
  plan: 1,
  amount: 1,
  currency: 1,
  stripeSessionId: 1,
  stripeSubscriptionId: 1,
  status: 1,
  createdAt: 1,
};
const userRoles = new Set(["customer", "vendor", "admin"]);
const serviceStatuses = new Set(["pending", "approved", "rejected"]);

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getAdminUserIds(userId) {
  const stringId = String(userId);
  const ids = [stringId];
  if (/^[a-f\d]{24}$/i.test(stringId)) {
    ids.push(new ObjectId(stringId));
  }
  return ids;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readQueryString(query, name, maxLength) {
  const value = query[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw createHttpError(400, `${name} must be a single string`);
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length > maxLength) {
    throw createHttpError(400, `${name} must be at most ${maxLength} characters`);
  }
  return trimmedValue || undefined;
}

export function parseAdminPagination(query = {}) {
  function readInteger(name, defaultValue, maximum) {
    const value = readQueryString(query, name, 10);
    if (value === undefined) {
      return defaultValue;
    }
    if (!/^\d+$/.test(value)) {
      throw createHttpError(400, `${name} must be a positive integer`);
    }

    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw createHttpError(400, `${name} must be between 1 and ${maximum}`);
    }
    return number;
  }

  return {
    page: readInteger("page", 1, 1000000),
    pageSize: readInteger("pageSize", 25, 100),
  };
}

export function parseAdminUserQuery(query = {}) {
  const { page, pageSize } = parseAdminPagination(query);
  const search = readQueryString(query, "search", 100);
  const role = readQueryString(query, "role", 20);
  if (role && !userRoles.has(role)) {
    throw createHttpError(400, "role must be customer, vendor, or admin");
  }

  const filter = {};
  if (role) {
    filter.role = role;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: pattern },
      { email: pattern },
      { businessName: pattern },
    ];
  }

  return { filter, page, pageSize };
}

export function parseAdminServiceQuery(query = {}) {
  const { page, pageSize } = parseAdminPagination(query);
  const search = readQueryString(query, "search", 100);
  const status = readQueryString(query, "status", 20);
  if (status && !serviceStatuses.has(status)) {
    throw createHttpError(400, "status must be pending, approved, or rejected");
  }

  const filter = {};
  if (status) {
    filter.status = status;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { serviceName: pattern },
      { category: pattern },
      { location: pattern },
      { description: pattern },
    ];
  }

  return { filter, page, pageSize };
}

export function parseAdminUserId(id) {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    id.includes("/") ||
    id.includes("\\")
  ) {
    throw createHttpError(400, "User ID is invalid");
  }
  return id;
}

export function parseAdminUserDetailId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw createHttpError(400, "User ID must be a valid MongoDB ObjectId");
  }
  return new ObjectId(id);
}

export function parseAdminUserBlockInput(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.isBlocked !== "boolean"
  ) {
    throw createHttpError(400, "isBlocked must be a boolean");
  }
  return { isBlocked: body.isBlocked };
}

export function parseAdminServiceUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "A service update object is required");
  }

  const fields = {};
  const unsupportedField = Object.keys(body).find(
    (field) => field !== "status" && field !== "isActive",
  );
  if (unsupportedField) {
    throw createHttpError(400, `Unsupported service field: ${unsupportedField}`);
  }
  if (Object.hasOwn(body, "status")) {
    if (typeof body.status !== "string" || !serviceStatuses.has(body.status)) {
      throw createHttpError(400, "status must be pending, approved, or rejected");
    }
    fields.status = body.status;
  }
  if (Object.hasOwn(body, "isActive")) {
    if (typeof body.isActive !== "boolean") {
      throw createHttpError(400, "isActive must be a boolean");
    }
    fields.isActive = body.isActive;
  }
  if (Object.keys(fields).length === 0) {
    throw createHttpError(400, "At least one service field must be provided");
  }
  return fields;
}

export function parseAdminServiceId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw createHttpError(400, "Service ID must be a valid MongoDB ObjectId");
  }
  return new ObjectId(id);
}

export async function loadAdminOverview(database) {
  const [
    totalUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    totalTransactions,
  ] =
    await Promise.all([
      database.collection("users").countDocuments({}),
      database.collection("users").countDocuments({ role: "vendor" }),
      database.collection("users").countDocuments({ role: "customer" }),
      database.collection("services").countDocuments({}),
      database.collection("services").countDocuments({ status: "pending" }),
      database.collection("transactions").countDocuments({}),
    ]);

  return {
    totalUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    totalTransactions,
  };
}

async function loadAdminServices(database, filter, page, pageSize) {
  const collection = database.collection("services");
  const [services, total] = await Promise.all([
    collection
      .find(filter, { projection: serviceProjection })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);
  const vendorIds = [
    ...new Set(
      services
        .map((service) => service.vendorId)
        .filter((vendorId) => vendorId !== undefined && vendorId !== null)
        .map(String),
    ),
  ];
  const vendorObjectIds = vendorIds.flatMap((id) =>
    /^[a-f\d]{24}$/i.test(id) ? [id, new ObjectId(id)] : [id],
  );
  const vendors = vendorObjectIds.length
    ? await database
        .collection("users")
        .find(
          { _id: { $in: vendorObjectIds } },
          { projection: { name: 1, email: 1, businessName: 1 } },
        )
        .toArray()
    : [];
  const vendorsById = new Map(vendors.map((vendor) => [String(vendor._id), vendor]));

  return {
    items: services.map((service) => ({
      ...service,
      vendor: vendorsById.get(String(service.vendorId))
        ? {
            name: vendorsById.get(String(service.vendorId)).name || "",
            email: vendorsById.get(String(service.vendorId)).email || "",
            businessName:
              vendorsById.get(String(service.vendorId)).businessName || "",
          }
        : null,
    })),
    total,
    page,
    pageSize,
  };
}

const router = Router();
const adminOnly = [verifyJwt, loadUser, requireRole("admin")];

router.get("/overview", ...adminOnly, async (req, res) => {
  const database = await connectDatabase();
  const data = await loadAdminOverview(database);
  return res.json({ success: true, data });
});

router.get("/users", ...adminOnly, async (req, res) => {
  const { filter, page, pageSize } = parseAdminUserQuery(req.query);
  const collection = (await connectDatabase()).collection("users");
  const [items, total] = await Promise.all([
    collection
      .find(filter, { projection: userProjection })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: { items, total, page, pageSize },
  });
});

router.get("/users/:id", ...adminOnly, async (req, res) => {
  const userId = parseAdminUserDetailId(req.params.id);
  const database = await connectDatabase();
  const user = await database
    .collection("users")
    .findOne(
      { _id: { $in: getAdminUserIds(userId) } },
      { projection: userDetailProjection },
    );
  if (!user) {
    throw createHttpError(404, "User not found");
  }
  return res.json({ success: true, data: user });
});

router.patch("/users/:id/block", ...adminOnly, async (req, res) => {
  const userId = parseAdminUserId(req.params.id);
  const { isBlocked } = parseAdminUserBlockInput(req.body);
  const database = await connectDatabase();
  const users = database.collection("users");
  const target = await users.findOne(
    { _id: { $in: getAdminUserIds(userId) } },
    { projection: { role: 1 } },
  );
  if (!target) {
    throw createHttpError(404, "User not found");
  }
  if (target.role === "admin") {
    throw createHttpError(403, "Admin accounts cannot be blocked here");
  }
  if (isBlocked && String(target._id) === String(req.user._id)) {
    throw createHttpError(409, "You cannot block your own account");
  }

  const result = await users.updateOne(
    { _id: target._id, role: { $ne: "admin" } },
    { $set: { isBlocked } },
  );
  if (!result.matchedCount) {
    throw createHttpError(403, "Admin accounts cannot be blocked here");
  }
  const user = await users.findOne(
    { _id: target._id },
    { projection: userProjection },
  );
  return res.json({ success: true, data: user });
});

router.get("/services", ...adminOnly, async (req, res) => {
  const { filter, page, pageSize } = parseAdminServiceQuery(req.query);
  const database = await connectDatabase();
  const data = await loadAdminServices(database, filter, page, pageSize);
  return res.json({ success: true, data });
});

router.patch("/services/:id", ...adminOnly, async (req, res) => {
  const serviceId = parseAdminServiceId(req.params.id);
  const fields = parseAdminServiceUpdate(req.body);
  const database = await connectDatabase();
  const collection = database.collection("services");
  const updates = { ...fields, updatedAt: new Date() };
  if (Object.hasOwn(fields, "status")) {
    updates.reviewedAt = new Date();
    updates.reviewedBy = String(req.user._id);
  }
  const result = await collection.updateOne(
    { _id: serviceId },
    { $set: updates },
  );
  if (!result.matchedCount) {
    throw createHttpError(404, "Service not found");
  }

  const service = await collection.findOne(
    { _id: serviceId },
    { projection: serviceProjection },
  );
  return res.json({ success: true, data: service });
});

router.delete("/services/:id", ...adminOnly, async (req, res) => {
  const serviceId = parseAdminServiceId(req.params.id);
  const database = await connectDatabase();
  const result = await database.collection("services").deleteOne({ _id: serviceId });
  if (!result.deletedCount) {
    throw createHttpError(404, "Service not found");
  }
  return res.json({
    success: true,
    data: { id: serviceId.toHexString() },
  });
});

router.get("/transactions", ...adminOnly, async (req, res) => {
  const { page, pageSize } = parseAdminPagination(req.query);
  const collection = (await connectDatabase()).collection("transactions");
  const [items, total] = await Promise.all([
    collection
      .find({}, { projection: transactionProjection })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    collection.countDocuments({}),
  ]);

  return res.json({
    success: true,
    data: { items, total, page, pageSize },
  });
});

export default router;
