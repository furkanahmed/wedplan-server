import "dotenv/config";
import { MongoClient } from "mongodb";

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured to seed the admin account.`);
  }

  return value;
}

function validateAdminPassword(password) {
  if (
    password.length < 6 ||
    password.length > 128 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password)
  ) {
    throw new Error(
      "ADMIN_PASSWORD must be 6-128 characters and include an uppercase and a lowercase letter.",
    );
  }
}

async function callAuthEndpoint(clientOrigin, endpoint, body) {
  let response;
  try {
    response = await fetch(new URL(`/api/auth/${endpoint}`, clientOrigin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: clientOrigin.origin,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Could not reach Better Auth at CLIENT_ORIGIN. Check that the frontend is running and CLIENT_ORIGIN is correct.`,
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Better Auth ${endpoint} returned a non-JSON response (HTTP ${response.status}).`,
    );
  }

  if (!response.ok || result?.error) {
    const message =
      typeof result?.message === "string"
        ? result.message
        : typeof result?.error?.message === "string"
          ? result.error.message
          : `HTTP ${response.status}`;
    throw new Error(`Better Auth ${endpoint} failed: ${message}`);
  }
}

async function main() {
  const mongoUri = getRequiredEnv("MONGODB_URI");
  const databaseName = getRequiredEnv("DB_NAME");
  const clientOriginValue = getRequiredEnv("CLIENT_ORIGIN");
  const adminEmail = getRequiredEnv("ADMIN_EMAIL").toLowerCase();
  const adminPassword = getRequiredEnv("ADMIN_PASSWORD");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new Error("ADMIN_EMAIL must be a valid email address.");
  }
  validateAdminPassword(adminPassword);

  let clientOrigin;
  try {
    clientOrigin = new URL(clientOriginValue);
  } catch {
    throw new Error("CLIENT_ORIGIN must be a valid frontend URL.");
  }

  const isLocalOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(
    clientOrigin.hostname,
  );
  if (
    clientOrigin.pathname !== "/" ||
    clientOrigin.search ||
    clientOrigin.hash ||
    clientOrigin.username ||
    clientOrigin.password ||
    (clientOrigin.protocol !== "https:" &&
      !(isLocalOrigin && clientOrigin.protocol === "http:"))
  ) {
    throw new Error(
      "CLIENT_ORIGIN must be an HTTPS origin (HTTP is allowed only for localhost).",
    );
  }

  const mongoClient = new MongoClient(mongoUri);
  try {
    await mongoClient.connect();
    const uriDatabaseName = mongoClient.db().databaseName;
    if (uriDatabaseName !== databaseName) {
      throw new Error(
        `DB_NAME (${databaseName}) does not match the database selected by MONGODB_URI (${uriDatabaseName}). Set both to the database used by frontend auth.`,
      );
    }

    const users = mongoClient.db().collection("users");
    const existingUser = await users.findOne({ email: adminEmail });

    if (existingUser) {
      await callAuthEndpoint(clientOrigin, "sign-in/email", {
        email: adminEmail,
        password: adminPassword,
      });
    } else {
      await callAuthEndpoint(clientOrigin, "sign-up/email", {
        name: "WedPlan Admin",
        email: adminEmail,
        password: adminPassword,
      });
    }

    const result = await users.updateOne(
      { email: adminEmail },
      { $set: { role: "admin", isBlocked: false } },
    );

    if (result.matchedCount !== 1) {
      throw new Error(
        "The admin account was not found in the configured database. Confirm DB_NAME and MONGODB_URI match the frontend database.",
      );
    }

    console.log("Admin account is ready.");
  } finally {
    await mongoClient.close();
  }
}

main().catch((error) => {
  console.error("Admin seed failed:", error.message);
  process.exitCode = 1;
});
