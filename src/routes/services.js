import { Router } from "express";
import { ObjectId } from "mongodb";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getVendorIds } from "../utils/vendor-id.js";
import {
  assertCanActivateService,
  isCurrentPremiumVendor,
  withVendorServiceQuota,
} from "../utils/vendor-service-quota.js";

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
const allowedServiceFields = new Set([
  "serviceName",
  "category",
  "description",
  "price",
  "location",
  "images",
  "isActive",
]);
const serviceCategories = new Set([
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
]);

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

export function parseVendorServiceInput(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "A service object is required");
  }

  const unsupportedField = Object.keys(body).find(
    (field) => !allowedServiceFields.has(field) || (field === "isActive" && !partial),
  );
  if (unsupportedField) {
    throw createHttpError(400, `Unsupported service field: ${unsupportedField}`);
  }

  const fields = {};
  const stringFields = [
    ["serviceName", 120],
    ["category", 80],
    ["description", 5000],
    ["location", 100],
  ];

  for (const [field, maxLength] of stringFields) {
    if (!Object.hasOwn(body, field)) {
      if (!partial) {
        throw createHttpError(400, `${field} is required`);
      }
      continue;
    }

    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw createHttpError(400, `${field} must be a non-empty string`);
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length > maxLength) {
      throw createHttpError(400, `${field} must be at most ${maxLength} characters`);
    }
    if (field === "category" && !serviceCategories.has(trimmedValue)) {
      throw createHttpError(400, "Choose a valid service category");
    }
    fields[field] = trimmedValue;
  }

  if (Object.hasOwn(body, "price")) {
    if (
      typeof body.price !== "number" ||
      !Number.isFinite(body.price) ||
      body.price <= 0
    ) {
      throw createHttpError(400, "price must be a positive number");
    }
    fields.price = body.price;
  } else if (!partial) {
    throw createHttpError(400, "price is required");
  }

  if (Object.hasOwn(body, "isActive")) {
    if (typeof body.isActive !== "boolean") {
      throw createHttpError(400, "isActive must be a boolean");
    }
    fields.isActive = body.isActive;
  }

  if (Object.hasOwn(body, "images")) {
    if (!Array.isArray(body.images)) {
      throw createHttpError(400, "images must be an array of HTTP(S) URLs");
    }
    fields.images = body.images.map((image) => {
      if (typeof image !== "string" || image.length > 2048) {
        throw createHttpError(400, "Each image must be a valid HTTP(S) URL");
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(image.trim());
      } catch {
        throw createHttpError(400, "Each image must be a valid HTTP(S) URL");
      }
      if (
        !image.trim() ||
        (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
      ) {
        throw createHttpError(400, "Each image must be a valid HTTP(S) URL");
      }
      return image.trim();
    });
  } else if (!partial) {
    fields.images = [];
  }

  if (partial && Object.keys(fields).length === 0) {
    throw createHttpError(400, "At least one service field must be provided");
  }

  return fields;
}

export function createOwnedServiceFilter(serviceId, vendorId) {
  return {
    _id: serviceId,
    vendorId: { $in: getVendorIds(vendorId) },
  };
}

export function serializePublicService(service, vendor, now = new Date()) {
  return {
    ...service,
    vendor: vendor
      ? {
          name: vendor.name || "",
          businessName: vendor.businessName || "",
          isPremium: isCurrentPremiumVendor(vendor, now),
        }
      : null,
  };
}

async function loadPublicVendors(services, database) {
  const vendorIds = [
    ...new Set(
      services
        .map((service) => service.vendorId)
        .filter((vendorId) => vendorId !== undefined && vendorId !== null),
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
const vendorOnly = [verifyJwt, loadUser, requireRole("vendor")];

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

router.post("/", ...vendorOnly, async (req, res) => {
  const fields = parseVendorServiceInput(req.body);
  const database = await connectDatabase();
  const service = await withVendorServiceQuota(
    database,
    req.user._id,
    async ({ session, vendor, activeServiceCount }) => {
      assertCanActivateService(vendor, activeServiceCount);
      const newService = {
        ...fields,
        vendorId: String(vendor._id),
        status: "pending",
        isActive: true,
        createdAt: new Date(),
      };
      const result = await database
        .collection("services")
        .insertOne(newService, { session });
      return { ...newService, _id: result.insertedId };
    },
  );

  return res.status(201).json({ success: true, data: service });
});

router.patch("/:id", ...vendorOnly, async (req, res) => {
  const serviceId = parseServiceId(req.params.id);
  const fields = parseVendorServiceInput(req.body, { partial: true });
  const database = await connectDatabase();
  const collection = database.collection("services");
  const filter = createOwnedServiceFilter(serviceId, req.user._id);
  if (Object.hasOwn(fields, "isActive")) {
    const service = await withVendorServiceQuota(
      database,
      req.user._id,
      async ({ session, vendor, activeServiceCount }) => {
        const currentService = await collection.findOne(filter, { session });
        if (!currentService) {
          throw createHttpError(404, "Service not found");
        }

        assertCanActivateService(vendor, activeServiceCount, {
          alreadyActive: currentService.isActive === true,
        });
        await collection.updateOne(filter, { $set: fields }, { session });
        return collection.findOne(filter, { session });
      },
    );
    return res.json({ success: true, data: service });
  }

  const result = await collection.updateOne(filter, { $set: fields });

  if (!result.matchedCount) {
    throw createHttpError(404, "Service not found");
  }

  const service = await collection.findOne(filter);
  return res.json({ success: true, data: service });
});

router.delete("/:id", ...vendorOnly, async (req, res) => {
  const serviceId = parseServiceId(req.params.id);
  const database = await connectDatabase();
  const result = await database
    .collection("services")
    .deleteOne(createOwnedServiceFilter(serviceId, req.user._id));

  if (!result.deletedCount) {
    throw createHttpError(404, "Service not found");
  }

  return res.json({ success: true, data: { id: serviceId.toHexString() } });
});

export default router;
