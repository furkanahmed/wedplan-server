import { Router } from "express";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { parseServiceId, createOwnedServiceFilter } from "./services.js";
import { getVendorIds } from "../utils/vendor-id.js";
import { isCurrentPremiumVendor } from "../utils/vendor-service-quota.js";

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function parseVendorProfileInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "A profile object is required");
  }

  const allowedFields = new Set(["name", "businessName", "image"]);
  const unsupportedField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );
  if (unsupportedField) {
    throw createHttpError(400, `Unsupported profile field: ${unsupportedField}`);
  }
  if (Object.keys(body).length === 0) {
    throw createHttpError(400, "At least one profile field must be provided");
  }

  const fields = {};
  for (const field of ["name", "businessName"]) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    if (typeof body[field] !== "string" || !body[field].trim()) {
      throw createHttpError(400, `${field} must be a non-empty string`);
    }
    if (body[field].trim().length > 120) {
      throw createHttpError(400, `${field} must be at most 120 characters`);
    }
    fields[field] = body[field].trim();
  }

  if (Object.hasOwn(body, "image")) {
    if (body.image === null || body.image === "") {
      fields.image = body.image;
    } else if (typeof body.image !== "string") {
      throw createHttpError(
        400,
        "image must be an HTTP(S) URL, null, or an empty string",
      );
    } else {
      if (body.image.trim().length > 2048) {
        throw createHttpError(400, "image must be at most 2048 characters");
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(body.image.trim());
      } catch {
        throw createHttpError(400, "image must be a valid HTTP(S) URL");
      }
      if (
        !body.image.trim() ||
        (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
      ) {
        throw createHttpError(400, "image must be a valid HTTP(S) URL");
      }
      fields.image = body.image.trim();
    }
  }

  return fields;
}

export async function loadVendorOverview(database, vendor, now = new Date()) {
  const vendorFilter = { vendorId: { $in: getVendorIds(vendor._id) } };
  const [totalServices, activeServices, pendingRequests, acceptedBookings] =
    await Promise.all([
      database.collection("services").countDocuments(vendorFilter),
      database
        .collection("services")
        .countDocuments({ ...vendorFilter, isActive: true }),
      database
        .collection("bookings")
        .countDocuments({ ...vendorFilter, status: "pending" }),
      database
        .collection("bookings")
        .countDocuments({ ...vendorFilter, status: "accepted" }),
    ]);

  return {
    totalServices,
    activeServices,
    pendingRequests,
    acceptedBookings,
    currentPlan: isCurrentPremiumVendor(vendor, now) ? "premium" : "free",
  };
}

const router = Router();
const vendorOnly = [verifyJwt, loadUser, requireRole("vendor")];

router.get("/services", ...vendorOnly, async (req, res) => {
  const database = await connectDatabase();
  const services = await database
    .collection("services")
    .find({ vendorId: { $in: getVendorIds(req.user._id) } })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  return res.json({ success: true, data: services });
});

router.get("/profile", ...vendorOnly, async (req, res) => {
  return res.json({
    success: true,
    data: {
      _id: req.user._id,
      name: req.user.name || "",
      email: req.user.email || "",
      businessName: req.user.businessName || "",
      image: req.user.image || null,
    },
  });
});

router.patch("/profile", ...vendorOnly, async (req, res) => {
  const fields = parseVendorProfileInput(req.body);
  const database = await connectDatabase();
  const users = database.collection("users");
  const userFilter = { _id: { $in: getVendorIds(req.user._id) } };
  await users.updateOne(userFilter, { $set: fields });
  const vendor = await users.findOne(userFilter);
  if (!vendor) {
    throw createHttpError(404, "Vendor account not found");
  }

  return res.json({
    success: true,
    data: {
      _id: vendor._id,
      name: vendor.name || "",
      email: vendor.email || "",
      businessName: vendor.businessName || "",
      image: vendor.image || null,
    },
  });
});

router.get("/services/:id", ...vendorOnly, async (req, res) => {
  const serviceId = parseServiceId(req.params.id);
  const database = await connectDatabase();
  const service = await database
    .collection("services")
    .findOne(createOwnedServiceFilter(serviceId, req.user._id));

  if (!service) {
    const error = new Error("Service not found");
    error.statusCode = 404;
    throw error;
  }

  return res.json({ success: true, data: service });
});

router.get(
  "/overview",
  ...vendorOnly,
  async (req, res) => {
    const database = await connectDatabase();
    const data = await loadVendorOverview(database, req.user);
    return res.json({ success: true, data });
  },
);

export default router;
