import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePublicServiceQuery,
  parseServiceId,
} from "../src/routes/services.js";
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
