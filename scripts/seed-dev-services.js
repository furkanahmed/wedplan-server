import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import {
  DEV_SERVICES,
  DEV_SERVICE_SEED_TAG,
  DEV_SERVICE_VENDORS,
  DEV_VENDOR_ACCOUNTS,
} from "./dev-service-data.js";

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured to seed development services.`);
  }
  return value;
}

function getLocalClientOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("CLIENT_ORIGIN must be a valid local frontend URL.");
  }

  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.protocol !== "http:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      "Development service seeding only uploads through a localhost CLIENT_ORIGIN.",
    );
  }

  return origin;
}

async function uploadSampleImage(imageUrl, filename, clientOrigin) {
  let sourceResponse;
  try {
    sourceResponse = await fetch(imageUrl);
  } catch {
    throw new Error(`Could not download sample image: ${imageUrl}`);
  }
  if (!sourceResponse.ok) {
    throw new Error(
      `Sample image download failed with HTTP ${sourceResponse.status}: ${imageUrl}`,
    );
  }

  const contentType = sourceResponse.headers.get("content-type")?.split(";")[0];
  if (!contentType?.startsWith("image/")) {
    throw new Error(`Sample URL did not return an image: ${imageUrl}`);
  }
  const image = await sourceResponse.arrayBuffer();
  if (!image.byteLength || image.byteLength > 32 * 1024 * 1024) {
    throw new Error(`Sample image must be between 1 byte and 32 MB: ${imageUrl}`);
  }

  const formData = new FormData();
  formData.set("image", new Blob([image], { type: contentType }), filename);

  let uploadResponse;
  try {
    uploadResponse = await fetch(new URL("/api/upload", clientOrigin), {
      method: "POST",
      body: formData,
    });
  } catch {
    throw new Error(
      "Could not reach the frontend image upload route. Start the frontend and check CLIENT_ORIGIN.",
    );
  }

  let result;
  try {
    result = await uploadResponse.json();
  } catch {
    throw new Error(
      `Image upload route returned invalid JSON (HTTP ${uploadResponse.status}).`,
    );
  }
  if (!uploadResponse.ok || typeof result?.url !== "string") {
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : `Image upload failed (HTTP ${uploadResponse.status}).`,
    );
  }

  return result.url;
}

async function ensureDevelopmentVendorAccounts(users, clientOrigin) {
  for (const account of DEV_VENDOR_ACCOUNTS) {
    const existing = await users.findOne({
      $or: [{ email: account.email }, { businessName: account.businessName }],
    });
    if (existing) {
      await users.updateOne(
        { _id: existing._id },
        {
          $set: {
            role: "vendor",
            isBlocked: false,
            businessName: account.businessName,
          },
        },
      );
      continue;
    }

    const password = getRequiredEnv("DEV_VENDOR_PASSWORD");
    const response = await fetch(
      new URL("/api/auth/sign-up/email", clientOrigin),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: clientOrigin.origin,
        },
        body: JSON.stringify({
          name: account.name,
          email: account.email,
          password,
          role: "vendor",
          businessName: account.businessName,
        }),
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error) {
      throw new Error(
        typeof result?.message === "string"
          ? result.message
          : `Could not create development vendor ${account.businessName}.`,
      );
    }
  }
}

async function seedServices(services, users, clientOrigin) {
  const vendorNames = DEV_SERVICE_VENDORS;
  const vendors = await users
    .find(
      {
        role: "vendor",
        isBlocked: { $ne: true },
        businessName: { $in: vendorNames },
      },
      {
        projection: {
          name: 1,
          businessName: 1,
          role: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
        },
      },
    )
    .toArray();
  const vendorsByName = new Map(
    vendors.map((vendor) => [vendor.businessName, vendor]),
  );
  const missingVendors = vendorNames.filter(
    (businessName) => !vendorsByName.has(businessName),
  );
  if (missingVendors.length) {
    throw new Error(
      `Register these vendor accounts first, using the exact Business Name: ${missingVendors.join(", ")}`,
    );
  }
  const duplicateVendors = vendorNames.filter(
    (businessName) =>
      vendors.filter((vendor) => vendor.businessName === businessName).length >
      1,
  );
  if (duplicateVendors.length) {
    throw new Error(
      `More than one vendor account uses these Business Names: ${duplicateVendors.join(", ")}`,
    );
  }

  const serviceCounts = new Map();
  for (const service of DEV_SERVICES) {
    serviceCounts.set(
      service.vendor,
      (serviceCounts.get(service.vendor) ?? 0) + 1,
    );
  }

  for (const [businessName, plannedCount] of serviceCounts) {
    const vendor = vendorsByName.get(businessName);
    const subscriptionExpiresAt = vendor.subscriptionExpiresAt
      ? new Date(vendor.subscriptionExpiresAt)
      : null;
    const hasCurrentPremium =
      vendor.subscriptionPlan === "premium" &&
      subscriptionExpiresAt !== null &&
      Number.isFinite(subscriptionExpiresAt.getTime()) &&
      subscriptionExpiresAt > new Date();
    if (hasCurrentPremium) {
      continue;
    }

    const vendorIds = [String(vendor._id)];
    if (vendor._id instanceof ObjectId) {
      vendorIds.push(vendor._id);
    }

    const existingActiveCount = await services.countDocuments({
      vendorId: { $in: vendorIds },
      isActive: true,
      devSeedTag: { $ne: DEV_SERVICE_SEED_TAG },
    });
    if (existingActiveCount + plannedCount > 3) {
      throw new Error(
        `${businessName} would exceed the free-vendor limit of 3 active services. Deactivate existing services before seeding.`,
      );
    }
  }

  const baseTime = Date.now() - DEV_SERVICES.length * 60_000;
  for (const service of DEV_SERVICES) {
    const vendor = vendorsByName.get(service.vendor);
    const existing = await services.findOne({
      devSeedTag: DEV_SERVICE_SEED_TAG,
      devSeedKey: service.key,
    });

    let images = existing?.images;
    if (
      !Array.isArray(images) ||
      images.length !== service.imageUrls.length ||
      JSON.stringify(existing?.devSeedImageSourceUrls) !==
        JSON.stringify(service.imageUrls) ||
      images.some((url) => typeof url !== "string" || !url.startsWith("https://"))
    ) {
      images = [];
      for (let index = 0; index < service.imageUrls.length; index += 1) {
        const url = await uploadSampleImage(
          service.imageUrls[index],
          `${service.key}-${index + 1}.jpg`,
          clientOrigin,
        );
        images.push(url);
      }
    }

    await services.updateOne(
      { devSeedTag: DEV_SERVICE_SEED_TAG, devSeedKey: service.key },
      {
        $set: {
          vendorId: String(vendor._id),
          serviceName: service.serviceName,
          category: service.category,
          description: service.description,
          price: service.price,
          location: service.location,
          images,
          devSeedImageSourceUrls: service.imageUrls,
          status: "approved",
          isActive: true,
          createdAt: new Date(baseTime + service.featuredOrder * 60_000),
        },
        $setOnInsert: {
          devSeedTag: DEV_SERVICE_SEED_TAG,
          devSeedKey: service.key,
        },
      },
      { upsert: true },
    );

    console.log(`Seeded: ${service.serviceName}`);
  }
}

async function main() {
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "development";
  }
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "Development service seeding is disabled unless NODE_ENV=development.",
    );
  }

  const mongoUri = getRequiredEnv("MONGODB_URI");
  const databaseName = getRequiredEnv("DB_NAME");
  const clientOrigin = getLocalClientOrigin(getRequiredEnv("CLIENT_ORIGIN"));
  const mongoClient = new MongoClient(mongoUri);

  try {
    await mongoClient.connect();
    if (mongoClient.db().databaseName !== databaseName) {
      throw new Error(
        `DB_NAME (${databaseName}) does not match the database selected by MONGODB_URI (${mongoClient.db().databaseName}).`,
      );
    }

    const database = mongoClient.db(databaseName);
    const services = database.collection("services");
    if (process.argv.includes("--cleanup")) {
      const result = await services.deleteMany({
        devSeedTag: DEV_SERVICE_SEED_TAG,
      });
      console.log(
        `Removed ${result.deletedCount} development sample services. ImgBB images are not deleted.`,
      );
      return;
    }

    await ensureDevelopmentVendorAccounts(
      database.collection("users"),
      clientOrigin,
    );
    await seedServices(
      services,
      database.collection("users"),
      clientOrigin,
    );
    console.log(
      "Development sample services are ready. The six newest sample listings cover all six categories.",
    );
  } finally {
    await mongoClient.close();
  }
}

main().catch((error) => {
  console.error("Development service seed failed:", error.message);
  process.exitCode = 1;
});
