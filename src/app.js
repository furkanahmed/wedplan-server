import express from "express";
import cors from "cors";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import servicesRouter from "./routes/services.js";
import vendorRouter from "./routes/vendor.js";
import bookingsRouter from "./routes/bookings.js";
import customerRouter from "./routes/customer.js";

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      const allowedOrigins = new Set(
        [process.env.CLIENT_ORIGIN, process.env.NODE_ENV === "development"
          ? "http://127.0.0.1:3000"
          : undefined].filter(Boolean),
      );
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("WedPlan Server is running!");
});

app.use("/api/v1/services", servicesRouter);
app.use("/api/v1/vendor", vendorRouter);
app.use("/api/v1/bookings", bookingsRouter);
app.use("/api/v1/customer", customerRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
