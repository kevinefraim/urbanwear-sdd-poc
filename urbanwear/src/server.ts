import { createApp } from "./app.js";
import { createClock } from "./clock.js";
import { getConfig } from "./config.js";
import { createDatabase, seedDatabase } from "./db.js";

const config = getConfig();
const db = createDatabase(config.databasePath);
seedDatabase(db);
createApp(db, createClock(config.testNow)).listen(config.port, () => console.log(`UrbanWear API listening on port ${config.port}`));
