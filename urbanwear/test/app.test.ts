import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("database migration retains legacy coupon usage history while allowing reuse", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "urbanwear-legacy-"));
  const filename = join(directory, "urbanwear.db");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = createDatabase(filename);
  seedDatabase(initial);
  initial.close();

  const legacy = new Database(filename);
  legacy.exec(`
    DROP TABLE coupon_usages;
    CREATE TABLE coupon_usages (
      coupon_code TEXT NOT NULL REFERENCES coupons(code),
      user_id INTEGER NOT NULL REFERENCES users(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      used_at TEXT NOT NULL,
      PRIMARY KEY (coupon_code, user_id)
    );
  `);
  legacy.prepare("INSERT INTO coupons (code, type, value, valid_from, valid_until, minimum_amount) VALUES (?, ?, ?, ?, ?, ?)")
    .run("LEGACY", "fixed", 10, "2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.000Z", 0);
  const order = legacy.prepare("INSERT INTO orders (user_id, subtotal, discount, total, coupon_code, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(1, 89.99, 10, 79.99, "LEGACY", "2026-06-15 12:00:00");
  legacy.prepare("INSERT INTO coupon_usages (coupon_code, user_id, order_id, used_at) VALUES (?, ?, ?, ?)")
    .run("LEGACY", 1, order.lastInsertRowid, "2026-06-15 12:00:00");
  legacy.close();

  const migrated = createDatabase(filename);
  t.after(() => migrated.close());
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_code = 'LEGACY'").get() as { count: number }).count, 1);
  assert.ok((migrated.prepare("PRAGMA table_info(coupon_usages)").all() as Array<{ pk: number }>).every((column) => column.pk === 0));
});

test("coupons discount eligible cart items", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-15T12:00:00.000Z"));
  const coupon = {
    code: "SNEAKERS20", type: "percentage", value: 20,
    validFrom: "2026-06-01T00:00:00.000Z", validUntil: "2026-06-30T23:59:59.000Z",
    minimumAmount: 100, categoryIds: [1],
  };

  await request(app).post("/coupons").send(coupon).expect(201);
  const found = await request(app).get("/coupons/SNEAKERS20").expect(200);
  assert.deepEqual(found.body, { ...coupon, validUntil: "2026-06-30T23:59:59.000Z" });
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 2 }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 4, quantity: 1 }).expect(201);
  const checkout = await request(app).post("/checkout/1").send({ couponCode: "SNEAKERS20" }).expect(201);
  assert.deepEqual(checkout.body, {
    id: 1, userId: 1, subtotal: 309.97, discount: 36, total: 273.97, couponCode: "SNEAKERS20",
  });

});

test("coupons allow three successful uses, at most once per UTC day, and retain their history", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  let now = new Date("2026-06-15T23:59:59.000Z");
  const app = createApp(db, { now: () => new Date(now) });
  await request(app).post("/coupons").send({
    code: "REUSE", type: "fixed", value: 10,
    validFrom: "2026-06-01", validUntil: "2026-06-30", minimumAmount: 0, categoryIds: [],
  }).expect(201);

  const addAndCheckout = async (expectedStatus: number) => {
    await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
    return request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(expectedStatus);
  };
  await addAndCheckout(201);
  now = new Date("2026-06-15T23:59:59.999Z");
  await addAndCheckout(400);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_code = 'REUSE'").get() as { count: number }).count, 1);
  assert.equal((await request(app).get("/cart/1")).body.items.length, 1);

  now = new Date("2026-06-16T00:00:00.000Z");
  await request(app).post("/checkout/1").send({ couponCode: "REUSE" }).expect(201);
  now = new Date("2026-06-17T12:00:00.000Z");
  await addAndCheckout(201);
  now = new Date("2026-06-18T12:00:00.000Z");
  await addAndCheckout(400);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_code = 'REUSE' AND user_id = 1").get() as { count: number }).count, 3);
});

test("coupon validation rejects unavailable coupons without modifying the cart", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-15T12:00:00.000Z"));
  await request(app).post("/coupons").send({
    code: "FIXED", type: "fixed", value: 500,
    validFrom: "2026-06-01T00:00:00.000Z", validUntil: "2026-06-30T23:59:59.000Z",
    minimumAmount: 100, categoryIds: [],
  }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  await request(app).post("/checkout/1").send({ couponCode: "FIXED" }).expect(400);
  assert.equal((await request(app).get("/cart/1")).body.items.length, 1);
  await request(app).post("/checkout/1").send({ couponCode: "UNKNOWN" }).expect(400);
});

test("a date-only validUntil remains valid through the end of that day", async (t) => {
  const db = createDatabase();
  seedDatabase(db);
  t.after(() => db.close());
  const app = createApp(db, createClock("2026-06-15T23:59:59.999Z"));
  await request(app).post("/coupons").send({
    code: "LASTDAY", type: "fixed", value: 10,
    validFrom: "2026-06-15", validUntil: "2026-06-15", minimumAmount: 0, categoryIds: [],
  }).expect(201);
  await request(app).post("/cart/1/items").send({ productId: 1, quantity: 1 }).expect(201);
  const checkout = await request(app).post("/checkout/1").send({ couponCode: "LASTDAY" }).expect(201);
  assert.equal(checkout.body.discount, 10);
});
