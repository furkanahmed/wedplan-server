import { Router } from "express";
import { ObjectId } from "mongodb";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getObjectIdAndStringIds, getUserIds } from "../utils/user-id.js";

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function parseCustomerProfileInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "A profile object is required");
  }

  const allowedFields = new Set(["name", "image"]);
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
  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw createHttpError(400, "name must be a non-empty string");
    }
    if (body.name.trim().length > 120) {
      throw createHttpError(400, "name must be at most 120 characters");
    }
    fields.name = body.name.trim();
  }

  if (Object.hasOwn(body, "image")) {
    if (body.image === null || body.image === "") {
      fields.image = body.image;
    } else if (typeof body.image !== "string") {
      throw createHttpError(400, "image must be an HTTP(S) URL, null, or an empty string");
    } else {
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

export async function loadCustomerOverview(database, customer) {
  const customerFilter = { customerId: { $in: getUserIds(customer._id) } };
  const [totalBookings, pendingBookings, acceptedBookings, rejectedBookings] =
    await Promise.all([
      database.collection("bookings").countDocuments(customerFilter),
      database
        .collection("bookings")
        .countDocuments({ ...customerFilter, status: "pending" }),
      database
        .collection("bookings")
        .countDocuments({ ...customerFilter, status: "accepted" }),
      database
        .collection("bookings")
        .countDocuments({ ...customerFilter, status: "rejected" }),
    ]);

  return {
    totalBookings,
    pendingBookings,
    acceptedBookings,
    rejectedBookings,
  };
}

export function createCustomerBookingFilter(bookingId, customerId) {
  return {
    _id: bookingId,
    customerId: { $in: getUserIds(customerId) },
  };
}

const router = Router();
const customerOnly = [verifyJwt, loadUser, requireRole("customer")];

router.get("/overview", ...customerOnly, async (req, res) => {
  const database = await connectDatabase();
  const data = await loadCustomerOverview(database, req.user);
  return res.json({ success: true, data });
});

router.get("/bookings", ...customerOnly, async (req, res) => {
  const database = await connectDatabase();
  const rawBookings = await database
    .collection("bookings")
    .find({ customerId: { $in: getUserIds(req.user._id) } })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const serviceIds = [
    ...new Set(rawBookings.map((booking) => String(booking.serviceId))),
  ].filter((id) => /^[a-f\d]{24}$/i.test(id));
  const services = serviceIds.length
    ? await database
        .collection("services")
        .find(
          { _id: { $in: serviceIds.map((id) => new ObjectId(id)) } },
          { projection: { serviceName: 1, category: 1, location: 1, images: 1 } },
        )
        .toArray()
    : [];
  const servicesById = new Map(
    services.map((service) => [String(service._id), service]),
  );
  const bookings = rawBookings.map((booking) => ({
    ...booking,
    serviceName:
      servicesById.get(String(booking.serviceId))?.serviceName ||
      "Wedding service",
  }));

  return res.json({ success: true, data: bookings });
});

router.patch("/bookings/:id/cancel", ...customerOnly, async (req, res) => {
  if (typeof req.params.id !== "string" || !/^[a-f\d]{24}$/i.test(req.params.id)) {
    throw createHttpError(400, "Booking ID must be a valid MongoDB ObjectId");
  }

  const bookingId = new ObjectId(req.params.id);
  const database = await connectDatabase();
  const collection = database.collection("bookings");
  const filter = {
    ...createCustomerBookingFilter(bookingId, req.user._id),
    status: { $in: ["pending", "accepted"] },
  };
  const result = await collection.updateOne(filter, {
    $set: { status: "cancelled", cancelledAt: new Date() },
  });

  if (!result.matchedCount) {
    throw createHttpError(404, "Cancellable booking not found");
  }

  const booking = await collection.findOne(
    createCustomerBookingFilter(bookingId, req.user._id),
  );
  return res.json({ success: true, data: booking });
});

router.get("/profile", ...customerOnly, async (req, res) => {
  return res.json({
    success: true,
    data: {
      _id: req.user._id,
      name: req.user.name || "",
      email: req.user.email || "",
      image: req.user.image || null,
    },
  });
});

router.patch("/profile", ...customerOnly, async (req, res) => {
  const fields = parseCustomerProfileInput(req.body);
  const database = await connectDatabase();
  const collection = database.collection("users");
  await collection.updateOne(
    { _id: { $in: getUserIds(req.user._id) } },
    { $set: fields },
  );

  const user = await collection.findOne(
    { _id: { $in: getUserIds(req.user._id) } },
  );
  if (!user) {
    throw createHttpError(404, "User account was not found");
  }

  return res.json({
    success: true,
    data: {
      _id: user._id,
      name: user.name || "",
      email: user.email || "",
      image: user.image || null,
    },
  });
});

export { getObjectIdAndStringIds };
export default router;
