import { MongoClient } from "mongodb";

let client;
let database;
let connectionPromise;

export async function connectDatabase() {
  if (database) {
    return database;
  }
  if (connectionPromise) {
    return connectionPromise;
  }

  if (!process.env.MONGODB_URI || !process.env.DB_NAME) {
    throw new Error("MONGODB_URI and DB_NAME must be configured");
  }

  const pendingClient = new MongoClient(process.env.MONGODB_URI);
  client = pendingClient;
  const pendingConnection = (async () => {
    await pendingClient.connect();
    const connectedDatabase = pendingClient.db(process.env.DB_NAME);
    await connectedDatabase.command({ ping: 1 });
    const services = connectedDatabase.collection("services");
    await services.createIndex({
      serviceName: "text",
      description: "text",
      category: "text",
      location: "text",
    });
    await services.createIndex({ status: 1, isActive: 1 });
    await services.createIndex({ vendorId: 1 });
    const bookings = connectedDatabase.collection("bookings");
    await bookings.createIndex({ vendorId: 1, status: 1, createdAt: -1 });
    await bookings.createIndex({ customerId: 1, createdAt: -1 });
    await bookings.createIndex({ customerId: 1, serviceId: 1, status: 1 });
    await bookings.createIndex({ serviceId: 1 });

    database = connectedDatabase;
    console.log(`MongoDB connected to ${process.env.DB_NAME}`);
    return database;
  })();
  connectionPromise = pendingConnection;

  try {
    return await pendingConnection;
  } finally {
    if (connectionPromise === pendingConnection) {
      connectionPromise = undefined;
    }
  }
}

export function getDatabase() {
  if (!database) {
    throw new Error("Database has not been initialized");
  }

  return database;
}

export async function closeDatabase() {
  if (client) {
    await client.close();
    client = undefined;
    database = undefined;
    connectionPromise = undefined;
  }
}
