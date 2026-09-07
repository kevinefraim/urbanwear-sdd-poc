import { getConfig } from "./config.js";
import { resetAndSeedDatabase } from "./db.js";

const db = resetAndSeedDatabase(getConfig().databasePath);
db.close();
console.log("Database reset and seed completed");
