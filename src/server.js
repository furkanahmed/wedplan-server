import "dotenv/config";
import app from "./app.js";
import { connectDatabase, closeDatabase } from "./config/database.js";

const PORT = process.env.PORT || 5000;

async function startServer() {
  await connectDatabase();

  const server = app.listen(PORT, () => {
    console.log(`WedPlan Server running at http://localhost:${PORT}`);
  });

  async function shutdown() {
    server.close();
    await closeDatabase();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch((error) => {
  console.error("Failed to start WedPlan Server:", error.message);
  process.exit(1);
});
