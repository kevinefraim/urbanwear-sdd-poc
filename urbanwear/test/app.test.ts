import assert from "node:assert/strict";
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

test("coupon use is limited per user and fixed discounts are capped", async (t) => {
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
