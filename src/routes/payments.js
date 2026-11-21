import { Router } from "express";
import Stripe from "stripe";
import { connectDatabase } from "../config/database.js";
import { loadUser, verifyJwt } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { getVendorIds } from "../utils/vendor-id.js";
import { isCurrentPremiumVendor } from "../utils/vendor-service-quota.js";

const router = Router();

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw createHttpError(500, "STRIPE_SECRET_KEY must be configured");
  }
  return new Stripe(secretKey);
}

function getClientOrigin() {
  const origin = process.env.CLIENT_ORIGIN;
  if (!origin) {
    throw createHttpError(500, "CLIENT_ORIGIN must be configured");
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw createHttpError(500, "CLIENT_ORIGIN must be a valid URL");
  }

  if (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") {
    throw createHttpError(500, "CLIENT_ORIGIN must use HTTP or HTTPS");
  }

  return parsedOrigin.origin;
}

function getStripeObjectId(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value.id === "string" && value.id) return value.id;
  return null;
}

export async function createVendorCheckoutSession({
  stripe,
  user,
  clientOrigin,
  priceId,
  now = new Date(),
}) {
  if (user?.role !== "vendor") {
    throw createHttpError(403, "A vendor account is required");
  }
  if (isCurrentPremiumVendor(user, now)) {
    throw createHttpError(409, "Your account already has an active Premium plan");
  }
  if (!priceId) {
    throw createHttpError(500, "STRIPE_PRICE_ID must be configured");
  }
  if (!user._id) {
    throw createHttpError(500, "Vendor account ID is missing");
  }

  const vendorId = String(user._id);
  const metadata = { vendorId, plan: "premium" };
  const customerDetails = user.stripeCustomerId
    ? { customer: user.stripeCustomerId }
    : { customer_email: user.email };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${clientOrigin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientOrigin}/payment/cancel`,
    ...customerDetails,
    metadata,
    subscription_data: { metadata },
  });

  if (typeof session.url !== "string" || !session.url) {
    throw createHttpError(502, "Stripe did not return a Checkout URL");
  }

  return session;
}

export function getSubscriptionPeriodEnd(subscription, priceId) {
  const items = subscription?.items?.data;
  const configuredPriceItem = Array.isArray(items)
    ? items.find((item) => item.price?.id === priceId)
    : null;
  const periodEnd =
    subscription?.current_period_end ??
    configuredPriceItem?.current_period_end ??
    items?.[0]?.current_period_end;

  if (!Number.isSafeInteger(periodEnd) || periodEnd <= 0) {
    throw createHttpError(
      502,
      "Stripe subscription does not include a valid current period end",
    );
  }

  return new Date(periodEnd * 1000);
}

async function updateVendorSubscription(database, vendorId, fields) {
  const result = await database.collection("users").updateOne(
    {
      _id: { $in: getVendorIds(vendorId) },
      role: "vendor",
    },
    { $set: fields },
  );

  if (!result.matchedCount) {
    throw createHttpError(404, "Vendor account for this Stripe subscription was not found");
  }
}

async function handleCheckoutCompleted(session, { database, stripe }) {
  if (session.mode !== "subscription") return;

  const vendorId = session.metadata?.vendorId;
  const subscriptionId = getStripeObjectId(session.subscription);
  const customerId = getStripeObjectId(session.customer);
  if (!vendorId || !subscriptionId || !customerId) {
    throw createHttpError(400, "Completed subscription Checkout is missing required IDs");
  }
  if (!["paid", "no_payment_required"].includes(session.payment_status)) {
    throw createHttpError(400, "Subscription Checkout payment is not complete");
  }
  if (!Number.isSafeInteger(session.amount_total) || session.amount_total < 0) {
    throw createHttpError(400, "Completed subscription Checkout has an invalid amount");
  }
  if (
    typeof session.id !== "string" ||
    !session.id ||
    !Number.isSafeInteger(session.created) ||
    session.created <= 0
  ) {
    throw createHttpError(400, "Completed subscription Checkout has invalid session details");
  }
  if (typeof session.currency !== "string" || !/^[a-z]{3}$/.test(session.currency)) {
    throw createHttpError(400, "Completed subscription Checkout has an invalid currency");
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.metadata?.vendorId !== vendorId) {
    throw createHttpError(400, "Checkout and subscription vendor metadata do not match");
  }

  const subscriptionExpiresAt = getSubscriptionPeriodEnd(
    subscription,
    process.env.STRIPE_PRICE_ID,
  );
  await updateVendorSubscription(database, vendorId, {
    stripeCustomerId: customerId,
    subscriptionPlan: "premium",
    subscriptionExpiresAt,
  });

  const transaction = {
    vendorId,
    plan: "premium",
    amount: session.amount_total,
    currency: session.currency,
    stripeSessionId: session.id,
    stripeSubscriptionId: subscriptionId,
    status: session.payment_status,
    createdAt: new Date(session.created * 1000),
  };

  try {
    await database.collection("transactions").insertOne(transaction);
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

async function handleInvoicePaid(invoice, { database, stripe }) {
  const subscriptionId =
    getStripeObjectId(invoice.parent?.subscription_details?.subscription) ??
    getStripeObjectId(invoice.subscription);
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const vendorId = subscription.metadata?.vendorId;
  if (!vendorId) return;

  const subscriptionExpiresAt = getSubscriptionPeriodEnd(
    subscription,
    process.env.STRIPE_PRICE_ID,
  );
  await updateVendorSubscription(database, vendorId, {
    subscriptionPlan: "premium",
    subscriptionExpiresAt,
  });
}

async function handleSubscriptionDeleted(subscription, { database }) {
  const vendorId = subscription.metadata?.vendorId;
  if (!vendorId) return;

  await updateVendorSubscription(database, vendorId, {
    subscriptionPlan: "free",
    subscriptionExpiresAt: null,
  });
}

export async function processStripeEvent(event, dependencies) {
  const eventObject = event.data?.object;
  if (!eventObject) {
    throw createHttpError(400, "Stripe event is missing its data object");
  }

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(eventObject, dependencies);
      break;
    case "invoice.paid":
      await handleInvoicePaid(eventObject, dependencies);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(eventObject, dependencies);
      break;
    default:
      break;
  }
}

export function parseStripeWebhookEvent(rawBody, signature, { stripe, webhookSecret }) {
  if (!Buffer.isBuffer(rawBody)) {
    throw createHttpError(400, "Stripe webhook requires the raw request body");
  }
  if (!webhookSecret) {
    throw createHttpError(500, "STRIPE_WEBHOOK_SECRET must be configured");
  }

  try {
    return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    if (
      (error?.type === "StripeSignatureVerificationError" ||
        error instanceof SyntaxError)
    ) {
      throw createHttpError(400, "Invalid Stripe webhook signature or payload");
    }
    throw error;
  }
}

export async function handleStripeWebhook(req, res, next) {
  try {
    const stripe = getStripeClient();
    const event = parseStripeWebhookEvent(
      req.body,
      req.get("stripe-signature"),
      { stripe, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET },
    );
    await processStripeEvent(event, {
      database: await connectDatabase(),
      stripe,
    });
    return res.json({ received: true });
  } catch (error) {
    return next(error);
  }
}

const vendorOnly = [verifyJwt, loadUser, requireRole("vendor")];

router.get("/subscription", ...vendorOnly, (req, res) => {
  const subscriptionExpiresAt = req.user.subscriptionExpiresAt
    ? new Date(req.user.subscriptionExpiresAt)
    : null;
  const currentPlan = isCurrentPremiumVendor(req.user) ? "premium" : "free";

  return res.json({
    success: true,
    data: {
      currentPlan,
      subscriptionExpiresAt:
        subscriptionExpiresAt && Number.isFinite(subscriptionExpiresAt.getTime())
          ? subscriptionExpiresAt.toISOString()
          : null,
      canManageSubscription: Boolean(req.user.stripeCustomerId),
    },
  });
});

router.post("/checkout", ...vendorOnly, async (req, res) => {
  if (isCurrentPremiumVendor(req.user)) {
    throw createHttpError(409, "Your account already has an active Premium plan");
  }

  const session = await createVendorCheckoutSession({
    stripe: getStripeClient(),
    user: req.user,
    clientOrigin: getClientOrigin(),
    priceId: process.env.STRIPE_PRICE_ID,
  });

  return res.json({
    success: true,
    data: { url: session.url },
  });
});

router.post("/portal", ...vendorOnly, async (req, res) => {
  if (!req.user.stripeCustomerId) {
    throw createHttpError(409, "No Stripe subscription is available to manage");
  }

  const session = await getStripeClient().billingPortal.sessions.create({
    customer: req.user.stripeCustomerId,
    return_url: `${getClientOrigin()}/dashboard/vendor/subscription`,
  });

  if (typeof session.url !== "string" || !session.url) {
    throw createHttpError(502, "Stripe did not return a Customer Portal URL");
  }

  return res.json({
    success: true,
    data: { url: session.url },
  });
});

export default router;
