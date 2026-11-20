import express from "express";
import cors from "cors";

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

export default app;
