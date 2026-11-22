# WedPlan Server

WedPlan Server is the Express.js REST API for the WedPlan wedding planning
marketplace. It uses MongoDB for data, verifies Better Auth JWTs with `jose`,
and handles Stripe Checkout and webhook events for Premium subscriptions.

## Features

- Role-based API for customers, vendors, and admins.
- JWT verification through Better Auth's JWKS endpoint.
- Database role and `isBlocked` checks on every protected request.
- Server-side ownership checks for services, bookings, and profile data.
- Public service search, category and location filtering, and price sorting.
- Free plan limit of three active services per vendor.
- Booking rules: no duplicate active booking for the same service and event
  date; only pending bookings can be cancelled or accepted/rejected.
- Stripe Checkout subscriptions and webhook-based Premium activation.
- Admin tools for users, services, overview counts, and read-only transactions.
- Admin seed script for creating or updating the admin account.

## Technology Stack

Versions are taken from `package.json`.

- Node.js with ES modules
- Express `5.3.0`
- MongoDB Node.js driver `7.9.0`
- `jose` `6.2.17`
- Stripe `23.1.0`
- CORS `2.8.6`
- dotenv `18.0.10`
- Node.js built-in test runner

## Live API

- API: https://wedplan-server-liart.vercel.app
- Public services endpoint: https://wedplan-server-liart.vercel.app/api/v1/services
- Live site: https://wed-plan-7c5o.vercel.app

The root API URL only shows a status message. The public services endpoint
returns approved services as JSON.

## Repositories

- Client: https://github.com/furkanahmed/WedPlan
- Server: https://github.com/furkanahmed/wedplan-server

## Installation and Local Development

Clone the server repository and install dependencies:

```bash
git clone https://github.com/furkanahmed/wedplan-server.git
cd wedplan-server
npm install
```

Create the local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead.

Fill in the variable names below in `.env`. Do not commit this file.

- `PORT`
- `NODE_ENV`
- `MONGODB_URI`
- `DB_NAME`
- `CLIENT_ORIGIN`
- `BETTER_AUTH_JWKS_URL`
- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `IMGBB_API_KEY`

Start the development server:

```bash
npm run dev
```

Run the test suite:

```bash
npm test
```

## Admin Seed

Run the seed script from the backend repository:

```bash
npm run seed-admin
```

The script creates or updates the admin account. The credentials come from the
`ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables. The frontend must be
running and `CLIENT_ORIGIN` must point to it because the script uses Better Auth
to create or sign in the account. The account is then assigned the `admin` role
in MongoDB.

## Extra Decisions

These decisions go beyond the assignment PDF:

- Services include an extra `isActive` field for vendor availability.
- `isActiveBooking` is not used.
- Stripe webhook events handled: `checkout.session.completed`, `invoice.paid`,
  and `customer.subscription.deleted`.
- Google sign-in creates Customer accounts. Vendors register with email and
  password.
