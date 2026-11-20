import { MongoClient } from "mongodb";

let client;
let database;

export async function connectDatabase() {
  if (database) {
    return database;
  }

  if (!process.env.MONGODB_URI || !process.env.DB_NAME) {
    throw new Error("MONGODB_URI and DB_NAME must be configured");
  }

  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  await client.db(process.env.DB_NAME).command({ ping: 1 });
  database = client.db(process.env.DB_NAME);

  console.log(`MongoDB connected to ${process.env.DB_NAME}`);
  return database;
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
  }
}
