import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createClock } from "../src/clock.js";
import { getConfig } from "../src/config.js";
import { createDatabase, resetAndSeedDatabase, seedDatabase } from "../src/db.js";

test("products, cart and checkout workflow", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db);

  const products = await request(app).get("/products").expect(200);
  assert.equal(products.body.length, 5);

  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 2 }).expect(201);
  const cart = await request(app).get("/cart/1").expect(200);
  assert.deepEqual(cart.body.items[0].quantity, 2);

  const checkout = await request(app).post("/checkout/1").expect(201);
  assert.equal(checkout.body.subtotal, 179.98);
  assert.equal(checkout.body.total, 179.98);
  assert.equal(checkout.body.id, 1);

  const emptied = await request(app).get("/cart/1").expect(200);
  assert.deepEqual(emptied.body.items, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM orders").get() as { count: number }).count, 1);
});

test("environment configuration and reset seed are reproducible", async (t) => {
  assert.deepEqual(getConfig({ PORT: "4100", DATABASE_PATH: "test.db", TEST_NOW: "2026-01-02T03:04:05.000Z" }), {
    port: 4100, databasePath: "test.db", testNow: "2026-01-02T03:04:05.000Z",
  });
  const directory = mkdtempSync(join(tmpdir(), "urbanwear-"));
  const filename = join(directory, "urbanwear.db");
  let db: ReturnType<typeof createDatabase> | undefined;
  t.after(() => {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  db = resetAndSeedDatabase(filename);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM products").get() as { count: number }).count, 5);
  db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run("Transient", "transient@example.com");
  db.close();

  db = resetAndSeedDatabase(filename);
  assert.ok(existsSync(filename));
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 2);

  const clock = createClock("2026-01-02T03:04:05.000Z");
  assert.equal(clock.now().toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(clock.now().toISOString(), "2026-01-02T03:04:05.000Z");
  const app = createApp(db, clock);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").expect(201);
  const order = db.prepare("SELECT created_at FROM orders WHERE id = 1").get() as { created_at: string };
  assert.equal(order.created_at, "2026-01-02 03:04:05");
});

test("opening a V1 database preserves coupon usage history in the V2 schema", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "urbanwear-v1-"));
  const filename = join(directory, "urbanwear.db");
  const legacy = new Database(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id));
    CREATE TABLE cart_items (user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (user_id, product_id));
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), subtotal REAL NOT NULL, total REAL NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coupons (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, type TEXT NOT NULL, value REAL NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT NOT NULL, minimum_amount REAL NOT NULL);
    CREATE TABLE coupon_categories (coupon_id INTEGER NOT NULL, category_id INTEGER NOT NULL, PRIMARY KEY (coupon_id, category_id));
    CREATE TABLE coupon_usages (coupon_id INTEGER NOT NULL REFERENCES coupons(id), user_id INTEGER NOT NULL REFERENCES users(id), order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id), PRIMARY KEY (coupon_id, user_id));
    INSERT INTO users VALUES (1, 'Ana', 'ana@example.com');
    INSERT INTO categories VALUES (1, 'Zapatillas');
    INSERT INTO coupons VALUES (1, 'LEGACY', 'fixed', 10, '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', 0);
    INSERT INTO orders VALUES (1, 1, 100, 90, '2026-06-01 12:34:56');
    INSERT INTO coupon_usages VALUES (1, 1, 1);
  `);
  legacy.close();

  const db = createDatabase(filename);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const history = db.prepare("SELECT id, coupon_id AS couponId, user_id AS userId, order_id AS orderId, used_at AS usedAt FROM coupon_usages").get() as {
    id: number; couponId: number; userId: number; orderId: number; usedAt: string;
  };
  assert.deepEqual(history, { id: 1, couponId: 1, userId: 1, orderId: 1, usedAt: "2026-06-01T12:34:56.000Z" });
});

test("coupons apply only to eligible categories and can be retrieved", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-01T12:00:00.000Z"));
  const payload = {
    code: "SNEAKERS20", type: "percentage", value: 20,
    validFrom: "2026-06-01T00:00:00.000Z", validUntil: "2026-06-30T23:59:59.000Z",
    minimumAmount: 100, categoryIds: [1],
  };

  const created = await request(app).post("/coupons").send(payload).expect(201);
  assert.equal(created.body.code, "SNEAKERS20");
  assert.deepEqual(created.body.categoryIds, [1]);
  const fetched = await request(app).get("/coupons/SNEAKERS20").expect(200);
  assert.equal(fetched.body.type, "percentage");

  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 4, quantity: 1 }).expect(201);
  const checkout = await request(app).post("/checkout/1").send({ couponCode: "SNEAKERS20" }).expect(201);
  assert.deepEqual(checkout.body, { id: 1, userId: 1, subtotal: 219.98, discount: 18, total: 201.98, couponCode: "SNEAKERS20" });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM coupon_usages").get() as { count: number }).count, 1);
});

test("segmented coupons can be used only by their allowed customers", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-01T12:00:00.000Z"));
  const coupon = {
    code: "ANAONLY", type: "fixed", value: 10,
    validFrom: "2026-06-01", validUntil: "2026-06-02", minimumAmount: 0,
    categoryIds: [], allowedUserIds: [1, 1],
  };

  const created = await request(app).post("/coupons").send(coupon).expect(201);
  assert.deepEqual(created.body.allowedUserIds, [1]);
  const fetched = await request(app).get("/coupons/ANAONLY").expect(200);
  assert.deepEqual(fetched.body.allowedUserIds, [1]);

  await request(app).post("/cart/2/items").send({ productId: 1, quantity: 1 }).expect(201);
  const rejected = await request(app).post("/checkout/2").send({ couponCode: "ANAONLY" }).expect(400);
  assert.equal(rejected.body.error, "Coupon is not available for this user");
  assert.equal((await request(app).get("/cart/2")).body.items.length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM orders").get() as { count: number }).count, 0);

  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "ANAONLY" }).expect(201);
  await request(app).post("/coupons").send({ ...coupon, code: "UNKNOWN", allowedUserIds: [999] }).expect(400);
});

test("coupons without allowed users remain general", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-01T12:00:00.000Z"));
  const payload = {
    code: "GENERAL", type: "fixed", value: 10,
    validFrom: "2026-06-01", validUntil: "2026-06-02", minimumAmount: 0, categoryIds: [],
  };
  const created = await request(app).post("/coupons").send(payload).expect(201);
  assert.deepEqual(created.body.allowedUserIds, []);
  await request(app).post("/cart/2/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/2").send({ couponCode: "GENERAL" }).expect(201);
});

test("coupon daily use is limited per user and fixed discounts are capped", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-01T12:00:00.000Z"));
  await request(app).post("/coupons").send({
    code: "CAP", type: "fixed", value: 200,
    validFrom: "2026-06-01", validUntil: "2026-06-02T23:59:59.000Z",
    minimumAmount: 0, categoryIds: [1],
  }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  const first = await request(app).post("/checkout/1").send({ couponCode: "CAP" }).expect(201);
  assert.equal(first.body.discount, 89.99);
  assert.equal(first.body.total, 0);

  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "CAP" }).expect(400);
  assert.equal((await request(app).get("/cart/1")).body.items.length, 1);
  await request(app).post("/cart/2/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/2").send({ couponCode: "CAP" }).expect(201);
});

test("coupon reuse is limited to one successful use per UTC day and three total uses", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  let now = new Date("2026-06-01T23:30:00.000Z");
  const app = createApp(db, { now: () => new Date(now.getTime()) });
  await request(app).post("/coupons").send({
    code: "REUSE", type: "fixed", value: 10,
    validFrom: "2026-06-01", validUntil: "2026-06-10", minimumAmount: 100, categoryIds: [],
  }).expect(201);

  // A rejected checkout neither creates an order nor consumes a future coupon use.
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(400);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM coupon_usages").get() as { count: number }).count, 0);
  await request(app).post("/cart/1/items").send({ productId: 2, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(201);

  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 2 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(400);
  assert.equal((await request(app).get("/cart/1")).body.items.length, 1);

  now = new Date("2026-06-02T00:00:00.000Z");
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(201);
  now = new Date("2026-06-03T12:00:00.000Z");
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 2 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(201);

  now = new Date("2026-06-04T12:00:00.000Z");
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 2 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(400);
  const usages = db.prepare("SELECT order_id AS orderId, used_at AS usedAt FROM coupon_usages WHERE coupon_id = 1 ORDER BY id").all() as Array<{ orderId: number; usedAt: string }>;
  assert.deepEqual(usages.map((usage) => usage.orderId), [1, 2, 3]);
  assert.deepEqual(usages.map((usage) => usage.usedAt), [
    "2026-06-01T23:30:00.000Z", "2026-06-02T00:00:00.000Z", "2026-06-03T12:00:00.000Z",
  ]);
});

test("coupon validation preserves the cart when a coupon cannot apply", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-01T12:00:00.000Z"));
  await request(app).post("/coupons").send({
    code: "BOOTS", type: "fixed", value: 10,
    validFrom: "2026-06-01", validUntil: "2026-06-02",
    minimumAmount: 100, categoryIds: [2],
  }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "BOOTS" }).expect(400);
  assert.equal((await request(app).get("/cart/1")).body.items.length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM orders").get() as { count: number }).count, 0);
  await request(app).post("/coupons").send({
    code: "INVALID", type: "percent", value: 10, validFrom: "bad", validUntil: "bad", minimumAmount: -1, categoryIds: [999],
  }).expect(400);
});

test("percentage coupons are bounded and validUntil is inclusive to the instant", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-01T12:00:00.500Z"));
  const commonFields = {
    validFrom: "2026-06-01T12:00:00.500Z", validUntil: "2026-06-01T12:00:00.500Z",
    minimumAmount: 0, categoryIds: [],
  };
  await request(app).post("/coupons").send({ code: "ZERO", type: "percentage", value: 0, ...commonFields }).expect(400);
  await request(app).post("/coupons").send({ code: "OVER", type: "percentage", value: 100.01, ...commonFields }).expect(400);
  await request(app).post("/coupons").send({ code: "FULL", type: "percentage", value: 100, ...commonFields }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  const checkout = await request(app).post("/checkout/1").send({ couponCode: "FULL" }).expect(201);
  assert.equal(checkout.body.discount, 89.99);
  assert.equal(checkout.body.total, 0);
});

test("a date-only validUntil remains valid through its entire UTC calendar day", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-09-10T23:59:59.999Z"));
  await request(app).post("/coupons").send({
    code: "LASTDAY", type: "fixed", value: 10,
    validFrom: "2026-09-01", validUntil: "2026-09-10", minimumAmount: 0, categoryIds: [],
  }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  const checkout = await request(app).post("/checkout/1").send({ couponCode: "LASTDAY" }).expect(201);
  assert.equal(checkout.body.discount, 10);
});

test("PATCH updates a coupon in place, preserves its history, and enforces active and maxUsesPerUser", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  let now = new Date("2026-06-01T12:00:00.000Z");
  const app = createApp(db, { now: () => new Date(now.getTime()) });
  await request(app).post("/coupons").send({
    code: "EDITABLE", type: "fixed", value: 10, validFrom: "2026-06-01", validUntil: "2026-06-10",
    minimumAmount: 0, categoryIds: [],
  }).expect(201);

  const changed = await request(app).patch("/coupons/EDITABLE").send({ maxUsesPerUser: 1 }).expect(200);
  assert.equal(changed.body.code, "EDITABLE");
  assert.equal(changed.body.maxUsesPerUser, 1);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "EDITABLE" }).expect(201);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_id = 1").get() as { count: number }).count, 1);

  now = new Date("2026-06-02T12:00:00.000Z");
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "EDITABLE" }).expect(400);
  await request(app).patch("/coupons/EDITABLE").send({ active: false }).expect(200);
  await request(app).post("/cart/2/items").send({ productId: 1, quantity: 1 }).expect(201);
  const inactive = await request(app).post("/checkout/2").send({ couponCode: "EDITABLE" }).expect(400);
  assert.equal(inactive.body.error, "Coupon is not currently active");
  assert.equal((await request(app).get("/cart/2")).body.items.length, 1);
  await request(app).patch("/coupons/EDITABLE").send({ maxUsesPerUser: 0 }).expect(400);
  await request(app).patch("/coupons/EDITABLE").send({ code: "RENAMED" }).expect(400);
});

test("PATCH accumulates scheduled revisions and exposes only the effective configuration", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  let now = new Date("2026-06-01T12:00:00.000Z");
  const app = createApp(db, { now: () => new Date(now.getTime()) });
  await request(app).post("/coupons").send({
    code: "SCHEDULED", type: "fixed", value: 10, validFrom: "2026-06-01", validUntil: "2026-06-10",
    minimumAmount: 0, categoryIds: [], allowedUserIds: [],
  }).expect(201);
  await request(app).patch("/coupons/SCHEDULED").send({
    effectiveFrom: "2026-06-03T00:00:00.000Z", value: 20, minimumAmount: 50,
  }).expect(200);
  await request(app).patch("/coupons/SCHEDULED").send({
    effectiveFrom: "2026-06-03T00:00:00.000Z", categoryIds: [2, 2], allowedUserIds: [2],
  }).expect(200);
  const before = await request(app).get("/coupons/SCHEDULED").expect(200);
  assert.equal(before.body.value, 10);
  assert.deepEqual(before.body.categoryIds, []);
  assert.equal(before.body.scheduledChanges, undefined);

  now = new Date("2026-06-03T00:00:00.000Z");
  const effective = await request(app).get("/coupons/SCHEDULED").expect(200);
  assert.equal(effective.body.value, 20);
  assert.equal(effective.body.minimumAmount, 50);
  assert.deepEqual(effective.body.categoryIds, [2]);
  assert.deepEqual(effective.body.allowedUserIds, [2]);
  await request(app).post("/cart/2/items").send({ productId: 4, quantity: 1 }).expect(201);
  const checkout = await request(app).post("/checkout/2").send({ couponCode: "SCHEDULED" }).expect(201);
  assert.equal(checkout.body.discount, 20);
});
