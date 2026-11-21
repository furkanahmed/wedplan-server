import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import app from "../src/app.js";
import {
  createVendorCheckoutSession,
  getSubscriptionPeriodEnd,
  parseStripeWebhookEvent,
  processStripeEvent,
} from "../src/routes/payments.js";

process.env.STRIPE_PRICE_ID = "price_monthly";

function createMockDatabase({ duplicateTransaction = false } = {}) {
  const updates = [];
  const transactions = [];
  return {
    updates,
    transactions,
    collection(name) {
      if (name === "users") {
        return {
          updateOne: async (filter, update) => {
            updates.push({ filter, update });
            return { matchedCount: 1 };
          },
        };
      }
      if (name === "transactions") {
        return {
          insertOne: async (transaction) => {
            if (duplicateTransaction) {
              const error = new Error("Duplicate transaction");
              error.code = 11000;
              throw error;
            }
            transactions.push(transaction);
            return { insertedId: "transaction-1" };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };
}

function createPremiumSubscription(vendorId = "vendor-1") {
  return {
    id: "sub_test_1",
    metadata: { vendorId },
    items: {
      data: [
        {
          price: { id: "price_monthly" },
          current_period_end: 2_000_000_000,
        },
      ],
    },
  };
}

function createCheckoutEvent(overrides = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        mode: "subscription",
        metadata: { vendorId: "vendor-1", plan: "premium" },
        subscription: "sub_test_1",
        customer: "cus_test_1",
        payment_status: "paid",
        amount_total: 900,
        currency: "usd",
        created: 1_700_000_000,
        ...overrides,
      },
    },
  };
}

test("vendor Checkout uses the configured recurring price and server-owned metadata", async () => {
  let createdParams;
  const session = await createVendorCheckoutSession({
    stripe: {
      checkout: {
        sessions: {
          create: async (params) => {
            createdParams = params;
            return { id: "cs_test_1", url: "https://checkout.stripe.test/session" };
          },
        },
      },
    },
    user: {
      _id: "vendor-1",
      email: "vendor@example.test",
      role: "vendor",
    },
    clientOrigin: "https://wedplan.example",
    priceId: "price_monthly",
  });

  assert.equal(session.url, "https://checkout.stripe.test/session");
  assert.equal(createdParams.mode, "subscription");
  assert.equal(Object.hasOwn(createdParams, "payment_method_types"), false);
  assert.deepEqual(createdParams.line_items, [
    { price: "price_monthly", quantity: 1 },
  ]);
  assert.deepEqual(createdParams.metadata, {
    vendorId: "vendor-1",
    plan: "premium",
  });
  assert.deepEqual(createdParams.subscription_data.metadata, {
    vendorId: "vendor-1",
    plan: "premium",
  });
  assert.equal(
    createdParams.success_url,
    "https://wedplan.example/payment/success?session_id={CHECKOUT_SESSION_ID}",
  );
  await assert.rejects(
    createVendorCheckoutSession({
      stripe: {},
      user: {
        _id: "vendor-1",
        role: "vendor",
        subscriptionPlan: "premium",
        subscriptionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
      clientOrigin: "https://wedplan.example",
      priceId: "price_monthly",
      now: new Date("2026-01-01T00:00:00.000Z"),
    }),
    { statusCode: 409 },
  );
});

test("subscription expiry uses the configured item period from Stripe SDK v23", () => {
  const periodEnd = getSubscriptionPeriodEnd(
    createPremiumSubscription(),
    "price_monthly",
  );
  assert.equal(periodEnd.toISOString(), "2033-05-18T03:33:20.000Z");
  assert.throws(
    () => getSubscriptionPeriodEnd({ items: { data: [] } }, "price_monthly"),
    { statusCode: 502 },
  );
});

test("completed Checkout activates Premium and stores one Stripe transaction", async () => {
  const database = createMockDatabase();
  const stripe = {
    subscriptions: {
      retrieve: async (id) => {
        assert.equal(id, "sub_test_1");
        return createPremiumSubscription();
      },
    },
  };

  await processStripeEvent(createCheckoutEvent(), { database, stripe });

  assert.deepEqual(database.updates[0].update, {
    $set: {
      stripeCustomerId: "cus_test_1",
      subscriptionPlan: "premium",
      subscriptionExpiresAt: new Date(2_000_000_000 * 1000),
    },
  });
  assert.deepEqual(database.transactions[0], {
    vendorId: "vendor-1",
    plan: "premium",
    amount: 900,
    currency: "usd",
    stripeSessionId: "cs_test_1",
    stripeSubscriptionId: "sub_test_1",
    status: "paid",
    createdAt: new Date(1_700_000_000 * 1000),
  });
});

test("duplicate Checkout deliveries do not fail transaction processing", async () => {
  const database = createMockDatabase({ duplicateTransaction: true });
  const stripe = {
    subscriptions: {
      retrieve: async () => createPremiumSubscription(),
    },
  };

  await assert.doesNotReject(
    processStripeEvent(createCheckoutEvent(), { database, stripe }),
  );
  assert.equal(database.updates.length, 1);
});

test("paid invoices refresh expiry and deleted subscriptions downgrade vendors", async () => {
  const database = createMockDatabase();
  const stripe = {
    subscriptions: {
      retrieve: async (id) => {
        assert.equal(id, "sub_test_1");
        return createPremiumSubscription();
      },
    },
  };

  await processStripeEvent(
    {
      type: "invoice.paid",
      data: {
        object: {
          parent: {
            subscription_details: { subscription: "sub_test_1" },
          },
        },
      },
    },
    { database, stripe },
  );
  await processStripeEvent(
    {
      type: "customer.subscription.deleted",
      data: { object: createPremiumSubscription() },
    },
    { database, stripe },
  );

  assert.deepEqual(database.updates[0].update, {
    $set: {
      subscriptionPlan: "premium",
      subscriptionExpiresAt: new Date(2_000_000_000 * 1000),
    },
  });
  assert.deepEqual(database.updates[1].update, {
    $set: {
      subscriptionPlan: "free",
      subscriptionExpiresAt: null,
    },
  });
});

test("Stripe webhook signature verification requires an unchanged raw body", () => {
  const stripe = new Stripe("sk_test_webhook");
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({
    id: "evt_test_webhook",
    object: "event",
    type: "customer.subscription.deleted",
    data: { object: createPremiumSubscription() },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });

  assert.equal(
    parseStripeWebhookEvent(Buffer.from(payload), signature, {
      stripe,
      webhookSecret: secret,
    }).id,
    "evt_test_webhook",
  );
  assert.throws(
    () =>
      parseStripeWebhookEvent(Buffer.from(payload), "invalid", {
        stripe,
        webhookSecret: secret,
      }),
    { statusCode: 400 },
  );
  assert.throws(
    () =>
      parseStripeWebhookEvent(payload, signature, {
        stripe,
        webhookSecret: secret,
      }),
    { statusCode: 400 },
  );
});

test("payment endpoints require a signed-in vendor and webhook rejects bad signatures", async (t) => {
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
  for (const [path, method] of [
    ["/api/v1/payments/subscription", "GET"],
    ["/api/v1/payments/checkout", "POST"],
    ["/api/v1/payments/portal", "POST"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    assert.equal(response.status, 401, path);
  }

  const previousSecretKey = process.env.STRIPE_SECRET_KEY;
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_webhook";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/webhooks/stripe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "invalid",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 400);
  } finally {
    if (previousSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecretKey;
    if (previousWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
    }
  }
});
