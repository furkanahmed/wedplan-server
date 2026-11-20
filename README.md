# WedPlan backend

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
