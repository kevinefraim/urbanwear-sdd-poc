import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDatabase, seedDatabase } from "../src/db.js";

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
