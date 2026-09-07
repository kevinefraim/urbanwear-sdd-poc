import { createDatabase, seedDatabase } from "./db.js";

const db = createDatabase(process.env.DATABASE_PATH ?? "urbanwear.db");
seedDatabase(db);
db.close();
console.log("Seed completed");
