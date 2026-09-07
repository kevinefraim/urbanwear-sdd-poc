import { createApp } from "./app.js";
import { createDatabase, seedDatabase } from "./db.js";

const db = createDatabase(process.env.DATABASE_PATH ?? "urbanwear.db");
seedDatabase(db);
const port = Number(process.env.PORT ?? 3000);
createApp(db).listen(port, () => console.log(`UrbanWear API listening on port ${port}`));
