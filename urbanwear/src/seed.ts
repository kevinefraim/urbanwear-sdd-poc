import { getConfig } from "./config.js";
import { createDatabase, seedDatabase } from "./db.js";

const db = createDatabase(getConfig().databasePath);
seedDatabase(db);
db.close();
console.log("Seed completed");
