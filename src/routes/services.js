import { Router } from "express";
import { ObjectId } from "mongodb";
import { connectDatabase } from "../config/database.js";

const publicServiceFields = {
  _id: 1,
  vendorId: 1,
  serviceName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  createdAt: 1,
};

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parsePublicServiceQuery(query = {}) {
  const search = readQueryString(query, "search", 100);
  const category = readQueryString(query, "category", 80);
  const location = readQueryString(query, "location", 100);
  const sortValue = readQueryString(query, "sort", 20);

  const filter = {
    status: "approved",
    isActive: true,
  };
  if (search) {
    filter.$text = { $search: search };
  }
  if (category) {
    filter.category = {
      $regex: `^${escapeRegex(category)}$`,
      $options: "i",
    };
  }
  if (location) {
    filter.location = {
      $regex: escapeRegex(location),
      $options: "i",
    };
  }

  let sort = { createdAt: -1, _id: -1 };
  if (sortValue === "price_asc") {
    sort = { price: 1, _id: 1 };
  } else if (sortValue === "price_desc") {
    sort = { price: -1, _id: -1 };
  } else if (sortValue) {
    throw createHttpError(400, "sort must be price_asc or price_desc");
  }

  return { filter, sort };
}

export function parseServiceId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw createHttpError(400, "Service ID must be a valid MongoDB ObjectId");
  }
  return new ObjectId(id);
}

export function serializePublicService(service, vendor, now = new Date()) {
  const expiresAt = vendor?.subscriptionExpiresAt
    ? new Date(vendor.subscriptionExpiresAt)
    : null;
  const isPremium =
    vendor?.subscriptionPlan === "premium" &&
    expiresAt !== null &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt > now;

  return {
    ...service,
    vendor: vendor
      ? {
          name: vendor.name || "",
          businessName: vendor.businessName || "",
          isPremium,
        }
      : null,
  };
}

async function loadPublicVendors(services, database) {
  const vendorIds = [
    ...new Set(
      services
        .map((service) => service.vendorId)
        .filter((vendorId) => typeof vendorId === "string" && vendorId),
    ),
  ];
  if (!vendorIds.length) {
    return new Map();
  }

  const userIds = vendorIds.flatMap((vendorId) => {
    const ids = [vendorId];
    if (/^[a-f\d]{24}$/i.test(vendorId)) {
      ids.push(new ObjectId(vendorId));
    }
    return ids;
  });
  const vendors = await database
    .collection("users")
    .find(
      { _id: { $in: userIds } },
      {
        projection: {
          name: 1,
          businessName: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
        },
      },
    )
    .toArray();

  return new Map(vendors.map((vendor) => [String(vendor._id), vendor]));
}

const router = Router();

router.get("/", async (req, res) => {
  const { filter, sort } = parsePublicServiceQuery(req.query);
  const database = await connectDatabase();
  const services = await database
    .collection("services")
    .find(filter, { projection: publicServiceFields })
    .sort(sort)
    .toArray();
  const vendors = await loadPublicVendors(services, database);

  return res.json({
    success: true,
    data: services.map((service) =>
      serializePublicService(
        service,
        vendors.get(String(service.vendorId)),
      ),
    ),
  });
});

router.get("/:id", async (req, res) => {
  const serviceId = parseServiceId(req.params.id);
  const database = await connectDatabase();
  const service = await database
    .collection("services")
    .findOne(
      { _id: serviceId, status: "approved", isActive: true },
      { projection: publicServiceFields },
    );

  if (!service) {
    throw createHttpError(404, "Service not found");
  }

  const vendors = await loadPublicVendors([service], database);
  return res.json({
    success: true,
    data: serializePublicService(service, vendors.get(String(service.vendorId))),
  });
});

export default router;
