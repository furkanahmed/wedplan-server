import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePublicServiceQuery,
  parseServiceId,
  serializePublicService,
} from "../src/routes/services.js";
import {
  DEV_SERVICES,
  DEV_SERVICE_VENDORS,
} from "../scripts/dev-service-data.js";
import app from "../src/app.js";

test("public service queries always include approved and active filters", () => {
  const { filter } = parsePublicServiceQuery({});

  assert.deepEqual(filter, {
    status: "approved",
    isActive: true,
  });
});

test("public service filters combine text, category, and escaped location search", () => {
  const { filter } = parsePublicServiceQuery({
    search: "wedding photo",
    category: "Wedding (Photo)",
    location: "New York.",
  });

  assert.deepEqual(filter, {
    status: "approved",
    isActive: true,
    $text: { $search: "wedding photo" },
    category: {
      $regex: "^Wedding \\(Photo\\)$",
      $options: "i",
    },
    location: {
      $regex: "New York\\.",
      $options: "i",
    },
  });
});

test("service list supports price sorting and rejects unknown sort values", () => {
  assert.deepEqual(parsePublicServiceQuery({ sort: "price_asc" }).sort, {
    price: 1,
    _id: 1,
  });
  assert.deepEqual(parsePublicServiceQuery({ sort: "price_desc" }).sort, {
    price: -1,
    _id: -1,
  });
  assert.throws(
    () => parsePublicServiceQuery({ sort: "oldest" }),
    { statusCode: 400 },
  );
});

test("service detail IDs must be 24-character hexadecimal ObjectIds", () => {
  assert.equal(parseServiceId("507f1f77bcf86cd799439011").toHexString(), "507f1f77bcf86cd799439011");
  assert.throws(() => parseServiceId("not-an-id"), { statusCode: 400 });
});

test("public services include safe vendor details and only mark current premium plans", () => {
  const now = new Date("2026-11-20T00:00:00.000Z");
  const service = { serviceName: "Wedding photography", vendorId: "vendor-1" };
  const currentVendor = {
    name: "Avery Smith",
    businessName: "Avery Weddings",
    subscriptionPlan: "premium",
    subscriptionExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
    email: "private@example.com",
  };

  const serialized = serializePublicService(service, currentVendor, now);
  assert.deepEqual(serialized.vendor, {
    name: "Avery Smith",
    businessName: "Avery Weddings",
    isPremium: true,
  });
  assert.equal("email" in serialized.vendor, false);
  assert.equal(
    serializePublicService(
      service,
      { ...currentVendor, subscriptionExpiresAt: new Date("2026-11-01T00:00:00.000Z") },
      now,
    ).vendor.isPremium,
    false,
  );
  assert.equal(
    serializePublicService(service, { ...currentVendor, subscriptionPlan: "free" }, now)
      .vendor.isPremium,
    false,
  );
});

test("development sample services cover every category in the six newest records", () => {
  const categories = [
    "Photography & Videography",
    "Wedding Venues",
    "Decoration & Florist",
    "Catering Services",
    "Makeup & Styling",
    "Wedding Fashion",
  ];
  const orderedServices = [...DEV_SERVICES].sort(
    (first, second) => first.featuredOrder - second.featuredOrder,
  );
  const featuredCategories = new Set(
    orderedServices.slice(-6).map((service) => service.category),
  );
  const vendorCounts = new Map(
    DEV_SERVICE_VENDORS.map((vendor) => [
      vendor,
      DEV_SERVICES.filter((service) => service.vendor === vendor).length,
    ]),
  );

  assert.equal(DEV_SERVICES.length, 8);
  assert.deepEqual([...featuredCategories].sort(), [...categories].sort());
  assert.ok(DEV_SERVICES.every((service) => Number.isInteger(service.price)));
  assert.ok(DEV_SERVICES.every((service) => service.imageUrls.length === 2));
  assert.ok([...vendorCounts.values()].every((count) => count <= 3));
});

test("public services routes return 400 for invalid sort and service IDs", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const { port } = server.address();
  const sortResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/services?sort=oldest`,
  );
  const idResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/services/not-an-id`,
  );

  assert.equal(sortResponse.status, 400);
  assert.equal(idResponse.status, 400);
});
