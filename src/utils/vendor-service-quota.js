import { getVendorIds } from "./vendor-id.js";

export const FREE_ACTIVE_SERVICE_LIMIT = 3;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function isCurrentPremiumVendor(vendor, now = new Date()) {
  const expiresAt = vendor?.subscriptionExpiresAt
    ? new Date(vendor.subscriptionExpiresAt)
    : null;

  return (
    vendor?.subscriptionPlan === "premium" &&
    expiresAt !== null &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt > now
  );
}

export function assertCanActivateService(
  vendor,
  activeServiceCount,
  { alreadyActive = false, now = new Date() } = {},
) {
  if (
    alreadyActive ||
    isCurrentPremiumVendor(vendor, now) ||
    activeServiceCount < FREE_ACTIVE_SERVICE_LIMIT
  ) {
    return;
  }

  throw createHttpError(
    409,
    "Free vendors can have at most 3 active services. Deactivate an existing service or upgrade to Premium.",
  );
}

export async function withVendorServiceQuota(database, vendorId, operation) {
  const session = database.client.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      const users = database.collection("users");
      const vendorFilter = { _id: { $in: getVendorIds(vendorId) } };
      const updateResult = await users.updateOne(
        vendorFilter,
        { $inc: { serviceQuotaRevision: 1 } },
        { session },
      );
      if (!updateResult.matchedCount) {
        throw createHttpError(404, "Vendor account not found");
      }

      const vendor = await users.findOne(vendorFilter, { session });
      if (vendor.role !== "vendor" || vendor.isBlocked) {
        throw createHttpError(403, "An active vendor account is required");
      }

      const activeServiceCount = await database
        .collection("services")
        .countDocuments(
          {
            vendorId: { $in: getVendorIds(vendorId) },
            isActive: true,
          },
          { session },
        );

      result = await operation({ session, vendor, activeServiceCount });
    });
    return result;
  } finally {
    await session.endSession();
  }
}
