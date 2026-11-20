import express from "express";
import cors from "cors";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import servicesRouter from "./routes/services.js";

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("WedPlan Server is running!");
});

app.use("/api/v1/services", servicesRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
