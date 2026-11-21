import { Router } from "express";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { parseServiceId, createOwnedServiceFilter } from "./services.js";
import { getVendorIds } from "../utils/vendor-id.js";
import { isCurrentPremiumVendor } from "../utils/vendor-service-quota.js";

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
