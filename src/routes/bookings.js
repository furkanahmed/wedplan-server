import { Router } from "express";
import { ObjectId } from "mongodb";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getVendorIds } from "../utils/vendor-id.js";
import { getObjectIdAndStringIds, getUserIds } from "../utils/user-id.js";
import { parseServiceId } from "./services.js";

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function parseBookingInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "A booking request object is required");
  }

  const allowedFields = new Set([
    "serviceId",
    "eventDate",
    "eventLocation",
    "message",
  ]);
  const unsupportedField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );
  if (unsupportedField) {
    throw createHttpError(400, `Unsupported booking field: ${unsupportedField}`);
  }

  if (
    typeof body.serviceId !== "string" ||
    !/^[a-f\d]{24}$/i.test(body.serviceId)
  ) {
    throw createHttpError(400, "serviceId must be a valid MongoDB ObjectId");
  }
  if (
    typeof body.eventLocation !== "string" ||
    !body.eventLocation.trim() ||
    body.eventLocation.trim().length > 100
  ) {
    throw createHttpError(
      400,
      "eventLocation must be a non-empty string of at most 100 characters",
    );
  }
  if (
    typeof body.message !== "string" ||
    !body.message.trim() ||
    body.message.trim().length > 3000
  ) {
    throw createHttpError(
      400,
      "message must be a non-empty string of at most 3000 characters",
    );
  }
  if (typeof body.eventDate !== "string") {
    throw createHttpError(400, "eventDate must be a YYYY-MM-DD string");
  }

  const eventDate = new Date(`${body.eventDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(body.eventDate) ||
    Number.isNaN(eventDate.getTime()) ||
    eventDate.toISOString().slice(0, 10) !== body.eventDate
  ) {
    throw createHttpError(400, "eventDate must be a valid YYYY-MM-DD string");
  }

  return {
    serviceId: new ObjectId(body.serviceId),
    eventDate: body.eventDate,
    eventLocation: body.eventLocation.trim(),
    message: body.message.trim(),
  };
}

export function parseBookingStatus(status) {
  if (status !== "accepted" && status !== "rejected") {
    throw createHttpError(400, "status must be accepted or rejected");
  }
  return status;
}

export function createVendorBookingFilter(bookingId, vendorId) {
  return {
    _id: bookingId,
    vendorId: { $in: getVendorIds(vendorId) },
  };
}

export function parseBookingId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) {
    throw createHttpError(400, "Booking ID must be a valid MongoDB ObjectId");
  }
  return new ObjectId(id);
}

const router = Router();

router.post(
  "/",
  verifyJwt,
  loadUser,
  requireRole("customer"),
  async (req, res) => {
    const fields = parseBookingInput(req.body);
    const database = await connectDatabase();
    const service = await database.collection("services").findOne({
      _id: fields.serviceId,
      status: "approved",
      isActive: true,
    });

    if (!service) {
      throw createHttpError(404, "Available service not found");
    }

    const normalizedVendorIds = getVendorIds(req.user._id).map(String);
    if (normalizedVendorIds.includes(String(service.vendorId))) {
      throw createHttpError(403, "You cannot book your own service");
    }

    const duplicate = await database.collection("bookings").findOne({
      customerId: { $in: getUserIds(req.user._id) },
      serviceId: { $in: getObjectIdAndStringIds(fields.serviceId) },
      status: { $in: ["pending", "accepted"] },
    });
    if (duplicate) {
      throw createHttpError(
        409,
        "You already have an active booking request for this service",
      );
    }

    const booking = {
      serviceId: fields.serviceId,
      vendorId: service.vendorId,
      customerId: req.user._id,
      eventDate: fields.eventDate,
      eventLocation: fields.eventLocation,
      message: fields.message,
      status: "pending",
      createdAt: new Date(),
    };
    const result = await database.collection("bookings").insertOne(booking);

    return res.status(201).json({
      success: true,
      data: { ...booking, _id: result.insertedId },
    });
  },
);

router.get(
  "/",
  verifyJwt,
  loadUser,
  requireRole("vendor"),
  async (req, res) => {
    const database = await connectDatabase();
    const rawBookings = await database
      .collection("bookings")
      .find({ vendorId: { $in: getVendorIds(req.user._id) } })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    const serviceIds = [
      ...new Set(rawBookings.map((booking) => String(booking.serviceId))),
    ].filter((id) => /^[a-f\d]{24}$/i.test(id));
    const customerIds = [
      ...new Set(rawBookings.map((booking) => String(booking.customerId))),
    ];

    const [services, customers] = await Promise.all([
      database
        .collection("services")
        .find(
          {
            _id: {
              $in: serviceIds.map((id) => new ObjectId(id)),
            },
          },
          { projection: { serviceName: 1 } },
        )
        .toArray(),
      database
        .collection("users")
        .find(
          {
            $or: customerIds.flatMap((id) =>
              /^[a-f\d]{24}$/i.test(id)
                ? [{ _id: id }, { _id: new ObjectId(id) }]
                : [{ _id: id }],
            ),
          },
          { projection: { name: 1, email: 1 } },
        )
        .toArray(),
    ]);
    const servicesById = new Map(
      services.map((service) => [String(service._id), service]),
    );
    const customersById = new Map(
      customers.map((customer) => [String(customer._id), customer]),
    );
    const bookings = rawBookings.map((booking) => ({
      ...booking,
      serviceName:
        servicesById.get(String(booking.serviceId))?.serviceName ||
        "Wedding service",
      customer:
        customersById.get(String(booking.customerId))?.name ||
        customersById.get(String(booking.customerId))?.email ||
        "Customer",
    }));

    return res.json({ success: true, data: bookings });
  },
);

router.patch(
  "/:id/status",
  verifyJwt,
  loadUser,
  requireRole("vendor"),
  async (req, res) => {
    const bookingId = parseBookingId(req.params.id);
    const status = parseBookingStatus(req.body?.status);
    const database = await connectDatabase();
    const collection = database.collection("bookings");
    const filter = {
      ...createVendorBookingFilter(bookingId, req.user._id),
      status: "pending",
    };
    const result = await collection.updateOne(filter, {
      $set: { status, respondedAt: new Date() },
    });

    if (!result.matchedCount) {
      throw createHttpError(404, "Booking not found");
    }

    const booking = await collection.findOne(
      createVendorBookingFilter(bookingId, req.user._id),
    );
    return res.json({ success: true, data: booking });
  },
);

router.get(
  "/my",
  verifyJwt,
  loadUser,
  requireRole("customer"),
  async (req, res) => {
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
            { projection: { serviceName: 1 } },
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
  },
);

router.patch(
  "/:id/cancel",
  verifyJwt,
  loadUser,
  requireRole("customer"),
  async (req, res) => {
    const bookingId = parseBookingId(req.params.id);
    const database = await connectDatabase();
    const collection = database.collection("bookings");
    const filter = {
      _id: bookingId,
      customerId: { $in: getUserIds(req.user._id) },
      status: { $in: ["pending", "accepted"] },
    };
    const result = await collection.updateOne(filter, {
      $set: { status: "cancelled", cancelledAt: new Date() },
    });

    if (!result.matchedCount) {
      throw createHttpError(404, "Cancellable booking not found");
    }

    const booking = await collection.findOne({
      _id: bookingId,
      customerId: { $in: getUserIds(req.user._id) },
    });
    return res.json({ success: true, data: booking });
  },
);

export default router;
