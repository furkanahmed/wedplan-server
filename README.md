# WedPlan backend

## Admin API

The admin API is available under `/api/v1/admin` and requires a valid
Better Auth bearer token for an admin account:

- `GET /overview` returns user, vendor, customer, service, pending-service, and
  transaction counts (`totalUsers`, `totalVendors`, `totalCustomers`,
  `totalServices`, `pendingServices`, and `totalTransactions`).
- `GET /users` supports `search`, `role`, `page`, and `pageSize`.
- `PATCH /users/:id/block` accepts `{ "isBlocked": true|false }`. Admin accounts
  are protected from being blocked.
- `GET /services` supports `search`, `status`, `page`, and `pageSize`.
- `PATCH /services/:id` accepts an approved/rejected/pending `status` and/or
  boolean `isActive`; `DELETE /services/:id` removes a service.
- `GET /transactions` is a read-only, paginated list of subscription records.

## Stripe Premium subscriptions

Create a recurring **USD $9/month** Price in Stripe test mode and set its ID as
`STRIPE_PRICE_ID`. Configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in
the server environment; never commit their values. Forward Stripe CLI events to
`/api/v1/webhooks/stripe` during local testing.

Vendors start Checkout with `POST /api/v1/payments/checkout`, check their
webhook-confirmed plan with `GET /api/v1/payments/subscription`, and manage
cancellation through `POST /api/v1/payments/portal`. The signed webhook handles
Checkout completion, paid invoices, and subscription deletion. Admins can view
transactions but cannot modify them.

Transaction `amount` is stored in Stripe's smallest currency unit (for example,
USD 900 represents $9.00); `currency` is the lowercase Stripe currency code.

## Development sample services (extra decision)

The development seed contains eight fictional sample listings and three
fictional vendor accounts: Lens & Vows Studio, Green Leaf Convention, and Glow
by Nusrat. These sample packages and prices are for development only; they do
not describe real businesses or guaranteed services. The six newest seeded
listings cover all six assignment categories. Stock images are downloaded from
Pexels and uploaded to ImgBB; they are illustrative images, not vendor
portfolios. Review the [Pexels license](https://www.pexels.com/license/) before
use.

To seed:

1. Set `MONGODB_URI`, `DB_NAME`, and a localhost
   `CLIENT_ORIGIN` in the backend environment.
2. Set a local-only `DEV_VENDOR_PASSWORD` if the seed needs to create demo
   vendor accounts. Do not commit this value.
3. Set `IMGBB_API_KEY` in the frontend `.env.local` and restart the frontend.
4. Keep the frontend running, then run `npm run seed-dev-services` from this
   backend repository.

The seed command refuses non-development environments and non-local upload
origins, checks the free-vendor active-service limit, and can be safely
re-run. It adds `devSeedTag` and `devSeedKey` metadata to seeded service
documents so `npm run seed-dev-services -- --cleanup` removes only those
records. Cleanup does not delete images already uploaded to ImgBB. Replace the
sample records with listings created through the product UI before final
submission.
