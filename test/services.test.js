import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnedServiceFilter,
  parseVendorServiceInput,
  parsePublicServiceQuery,
  parseServiceId,
  serializePublicService,
} from "../src/routes/services.js";
import { loadVendorOverview } from "../src/routes/vendor.js";
import {
  assertCanActivateService,
  isCurrentPremiumVendor,
  withVendorServiceQuota,
} from "../src/utils/vendor-service-quota.js";
import {
  DEV_SERVICES,
  DEV_SERVICE_VENDORS,
} from "../scripts/dev-service-data.js";
import app from "../src/app.js";
import { requireRole } from "../src/middleware/requireRole.js";
import {
  createVendorBookingFilter,
  parseBookingId,
  parseBookingInput,
  parseBookingStatus,
} from "../src/routes/bookings.js";
import {
  createCustomerBookingFilter,
  loadCustomerOverview,
  parseCustomerProfileInput,
} from "../src/routes/customer.js";

test("customer profile input accepts only name and image updates", () => {
  assert.deepEqual(
    parseCustomerProfileInput({
      name: "  Customer Name  ",
      image: " https://images.example.com/customer.jpg ",
    }),
    {
      name: "Customer Name",
      image: "https://images.example.com/customer.jpg",
    },
  );
  assert.deepEqual(parseCustomerProfileInput({ image: null }), { image: null });
  assert.throws(() => parseCustomerProfileInput({ role: "admin" }), {
    statusCode: 400,
  });
  assert.throws(() => parseCustomerProfileInput({}), { statusCode: 400 });
});

test("customer overview counts owned booking statuses", async () => {
  const calls = [];
  const database = {
    collection(name) {
      return {
        countDocuments: async (filter) => {
          calls.push({ name, filter });
          if (filter.status === "pending") return 3;
          if (filter.status === "accepted") return 2;
          if (filter.status === "rejected") return 1;
          return 6;
        },
      };
    },
  };
  const overview = await loadCustomerOverview(database, {
    _id: "507f1f77bcf86cd799439011",
  });

  assert.deepEqual(overview, {
    totalBookings: 6,
    pendingBookings: 3,
    acceptedBookings: 2,
    rejectedBookings: 1,
  });
  assert.ok(calls.every(({ name }) => name === "bookings"));
  assert.deepEqual(
    calls[0].filter.customerId.$in.map(String),
    ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439011"],
  );
});

test("customer booking cancellation stays owner-scoped", () => {
  const filter = createCustomerBookingFilter(
    parseBookingId("507f1f77bcf86cd799439012"),
    "507f1f77bcf86cd799439013",
  );
  assert.equal(filter._id.toHexString(), "507f1f77bcf86cd799439012");
  assert.deepEqual(filter.customerId.$in.map(String), [
    "507f1f77bcf86cd799439013",
    "507f1f77bcf86cd799439013",
  ]);
});

test("booking requests validate the confirmed service form fields", () => {
  const booking = parseBookingInput({
    serviceId: "507f1f77bcf86cd799439011",
    eventDate: "2026-12-20",
    eventLocation: "Dhaka",
    message: "Please contact us for a wedding package.",
  });

  assert.equal(booking.serviceId.toHexString(), "507f1f77bcf86cd799439011");
  assert.equal(booking.eventDate, "2026-12-20");
  assert.equal(booking.eventLocation, "Dhaka");
  assert.equal(booking.message, "Please contact us for a wedding package.");
  assert.throws(
    () => parseBookingInput({ serviceId: "not-an-id" }),
    { statusCode: 400 },
  );
  assert.throws(
    () =>
      parseBookingInput({
        serviceId: "507f1f77bcf86cd799439011",
        eventDate: "2026-02-30",
        eventLocation: "Dhaka",
        message: "Invalid date",
      }),
    { statusCode: 400 },
  );
});

test("booking status changes only allow accept or reject and stay vendor-owned", () => {
  assert.equal(parseBookingStatus("accepted"), "accepted");
  assert.equal(parseBookingStatus("rejected"), "rejected");
  assert.throws(() => parseBookingStatus("cancelled"), { statusCode: 400 });
  assert.equal(
    parseBookingId("507f1f77bcf86cd799439012").toHexString(),
    "507f1f77bcf86cd799439012",
  );
  assert.throws(() => parseBookingId("bad-id"), { statusCode: 400 });

  const filter = createVendorBookingFilter(
    parseBookingId("507f1f77bcf86cd799439012"),
    "507f1f77bcf86cd799439013",
  );
  assert.equal(filter._id.toHexString(), "507f1f77bcf86cd799439012");
  assert.equal("status" in filter, false);
  assert.deepEqual(filter.vendorId.$in.map(String), [
    "507f1f77bcf86cd799439013",
    "507f1f77bcf86cd799439013",
  ]);
});

test("requireRole allows vendors and rejects unauthenticated or wrong-role requests", () => {
  const vendorMiddleware = requireRole("vendor");

  assert.equal(
    vendorMiddleware(
      { user: { role: "customer" } },
      {},
      (error) => assert.equal(error.statusCode, 403),
    ),
    undefined,
  );
  vendorMiddleware(
    {},
    {},
    (error) => assert.equal(error.statusCode, 401),
  );

  let nextCalled = false;
  vendorMiddleware(
    { user: { role: "vendor" } },
    {},
    (error) => {
      assert.equal(error, undefined);
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
});

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

test("vendor service input validates fields and normalizes image URLs", () => {
  const service = parseVendorServiceInput({
    serviceName: "  Wedding photography  ",
    category: "Photography & Videography",
    description: " Full-day coverage ",
    price: 25000,
    location: " Dhaka ",
    images: [" https://images.example.com/one.jpg "],
  });

  assert.deepEqual(service, {
    serviceName: "Wedding photography",
    category: "Photography & Videography",
    description: "Full-day coverage",
    price: 25000,
    location: "Dhaka",
    images: ["https://images.example.com/one.jpg"],
  });
  assert.throws(
    () => parseVendorServiceInput({ ...service, vendorId: "another-vendor" }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseVendorServiceInput({ ...service, status: "approved" }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseVendorServiceInput({ ...service, images: ["javascript:alert(1)"] }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseVendorServiceInput({ price: -1 }, { partial: true }),
    { statusCode: 400 },
  );
  assert.deepEqual(
    parseVendorServiceInput({ isActive: false }, { partial: true }),
    { isActive: false },
  );
  assert.throws(
    () => parseVendorServiceInput({ isActive: "false" }, { partial: true }),
    { statusCode: 400 },
  );
  assert.throws(
    () => parseVendorServiceInput({ ...service, isActive: false }),
    { statusCode: 400 },
  );
});

test("free vendors can have at most three active services", () => {
  const freeVendor = { subscriptionPlan: "free" };
  assert.doesNotThrow(() => assertCanActivateService(freeVendor, 2));
  assert.throws(() => assertCanActivateService(freeVendor, 3), {
    statusCode: 409,
  });
  assert.doesNotThrow(() =>
    assertCanActivateService(freeVendor, 3, { alreadyActive: true }),
  );
});

test("current premium vendors bypass the active-service limit", () => {
  const now = new Date("2026-11-21T00:00:00.000Z");
  const premiumVendor = {
    subscriptionPlan: "premium",
    subscriptionExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
  };
  const expiredVendor = {
    subscriptionPlan: "premium",
    subscriptionExpiresAt: new Date("2026-11-01T00:00:00.000Z"),
  };

  assert.equal(isCurrentPremiumVendor(premiumVendor, now), true);
  assert.equal(isCurrentPremiumVendor(expiredVendor, now), false);
  assert.doesNotThrow(() =>
    assertCanActivateService(premiumVendor, 10, { now }),
  );
  assert.throws(
    () => assertCanActivateService(expiredVendor, 3, { now }),
    { statusCode: 409 },
  );
});

test("service quota operations serialize against the vendor account", async () => {
  const calls = [];
  const session = {
    withTransaction: async (operation) => operation(),
    endSession: async () => calls.push("session-ended"),
  };
  const vendor = { _id: "vendor-1", role: "vendor", subscriptionPlan: "free" };
  const database = {
    client: {
      startSession: () => session,
    },
    collection(name) {
      if (name === "users") {
        return {
          updateOne: async (filter, update, options) => {
            calls.push({ name, filter, update, options });
            return { matchedCount: 1 };
          },
          findOne: async (filter, options) => {
            calls.push({ name, find: filter, options });
            return vendor;
          },
        };
      }
      return {
        countDocuments: async (filter, options) => {
          calls.push({ name, filter, options });
          return 2;
        },
      };
    },
  };

  const result = await withVendorServiceQuota(database, vendor._id, async (context) => ({
    vendor: context.vendor,
    activeServiceCount: context.activeServiceCount,
  }));

  assert.equal(result.vendor, vendor);
  assert.equal(result.activeServiceCount, 2);
  assert.equal(calls[0].update.$inc.serviceQuotaRevision, 1);
  assert.equal(calls[0].options.session, session);
  assert.equal(calls.find((call) => call.name === "services").options.session, session);
  assert.equal(calls.at(-1), "session-ended");
});

test("vendor service ownership filters match string and ObjectId owner IDs", () => {
  const filter = createOwnedServiceFilter(
    parseServiceId("507f1f77bcf86cd799439011"),
    "507f1f77bcf86cd799439012",
  );

  assert.equal(filter._id.toHexString(), "507f1f77bcf86cd799439011");
  assert.deepEqual(filter.vendorId.$in.map(String), [
    "507f1f77bcf86cd799439012",
    "507f1f77bcf86cd799439012",
  ]);
  assert.notEqual(filter.vendorId.$in[0], filter.vendorId.$in[1]);
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

test("vendor overview counts owned services and booking statuses", async () => {
  const calls = [];
  const database = {
    collection(name) {
      return {
        countDocuments: async (filter) => {
          calls.push({ name, filter });
          if (name === "services") {
            return filter.isActive ? 2 : 5;
          }
          return filter.status === "pending" ? 3 : 1;
        },
      };
    },
  };
  const now = new Date("2026-11-20T00:00:00.000Z");
  const vendor = {
    _id: "507f1f77bcf86cd799439011",
    subscriptionPlan: "premium",
    subscriptionExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
  };

  const overview = await loadVendorOverview(database, vendor, now);

  assert.deepEqual(overview, {
    totalServices: 5,
    activeServices: 2,
    pendingRequests: 3,
    acceptedBookings: 1,
    currentPlan: "premium",
  });
  assert.deepEqual(
    calls.map(({ name, filter }) => [
      name,
      filter.vendorId.$in.map(String),
      filter.isActive ?? filter.status,
    ]),
    [
      ["services", [vendor._id, vendor._id], undefined],
      ["services", [vendor._id, vendor._id], true],
      ["bookings", [vendor._id, vendor._id], "pending"],
      ["bookings", [vendor._id, vendor._id], "accepted"],
    ],
  );
});

test("vendor overview treats an expired premium subscription as free", async () => {
  const database = {
    collection() {
      return { countDocuments: async () => 0 };
    },
  };
  const overview = await loadVendorOverview(
    database,
    {
      _id: "vendor-1",
      subscriptionPlan: "premium",
      subscriptionExpiresAt: new Date("2026-11-01T00:00:00.000Z"),
    },
    new Date("2026-11-20T00:00:00.000Z"),
  );

  assert.equal(overview.currentPlan, "free");
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
  const vendorOverviewResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/vendor/overview`,
  );
  const vendorServicesResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/vendor/services`,
  );
  const createServiceResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/services`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const toggleServiceResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/services/507f1f77bcf86cd799439011`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    },
  );
  const createBookingResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/bookings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const vendorBookingsResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/bookings`,
  );
  const updateBookingResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/bookings/507f1f77bcf86cd799439011/status`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "accepted" }),
    },
  );

  assert.equal(sortResponse.status, 400);
  assert.equal(idResponse.status, 400);
  assert.equal(vendorOverviewResponse.status, 401);
  assert.equal(vendorServicesResponse.status, 401);
  assert.equal(createServiceResponse.status, 401);
  assert.equal(toggleServiceResponse.status, 401);
  assert.equal(createBookingResponse.status, 401);
  assert.equal(vendorBookingsResponse.status, 401);
  assert.equal(updateBookingResponse.status, 401);
});
