import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDatabase } from "../config/database.js";

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

const router = Router();

router.get("/", async (req, res) => {
  const { filter, sort } = parsePublicServiceQuery(req.query);
  const services = await getDatabase()
    .collection("services")
    .find(filter, { projection: publicServiceFields })
    .sort(sort)
    .toArray();

  return res.json({ success: true, data: services });
});

router.get("/:id", async (req, res) => {
  const serviceId = parseServiceId(req.params.id);
  const service = await getDatabase()
    .collection("services")
    .findOne(
      { _id: serviceId, status: "approved", isActive: true },
      { projection: publicServiceFields },
    );

  if (!service) {
    throw createHttpError(404, "Service not found");
  }

  return res.json({ success: true, data: service });
});

export default router;
