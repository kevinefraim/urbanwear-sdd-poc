import express from "express";
import { createClock, toSqliteTimestamp, type Clock } from "./clock.js";
import type { Db } from "./db.js";

type Product = { id: number; name: string; price: number; categoryId: number };
type CartItem = Product & { quantity: number };
type Coupon = {
  code: string;
  type: "percentage" | "fixed";
  value: number;
  validFrom: string;
  validUntil: string;
  minimumAmount: number;
};

const money = (amount: number) => Number(amount.toFixed(2));
const couponDate = (value: unknown, endOfDay = false): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const date = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59.999Z`
    : value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export function createApp(db: Db, clock: Clock = createClock()) {
  const app = express();
  app.use(express.json());

  const userExists = (id: number) => Boolean(db.prepare("SELECT 1 FROM users WHERE id = ?").get(id));
  const cart = (userId: number) => db.prepare(`
    SELECT p.id AS productId, p.name, p.price, ci.quantity
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ? ORDER BY p.id
  `).all(userId);
  const checkoutCart = (userId: number) => db.prepare(`
    SELECT p.id AS productId, p.name, p.price, p.category_id AS categoryId, ci.quantity
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ? ORDER BY p.id
  `).all(userId) as CartItem[];

  const couponWithCategories = (code: string): (Coupon & { categoryIds: number[] }) | undefined => {
    const coupon = db.prepare(`SELECT code, type, value, valid_from AS validFrom,
      valid_until AS validUntil, minimum_amount AS minimumAmount FROM coupons WHERE code = ?`).get(code) as Coupon | undefined;
    if (!coupon) return undefined;
    const categoryIds = (db.prepare("SELECT category_id AS categoryId FROM coupon_categories WHERE coupon_code = ? ORDER BY category_id")
      .all(code) as Array<{ categoryId: number }>).map(({ categoryId }) => categoryId);
    return { ...coupon, categoryIds };
  };

  app.get("/products", (_req, res) => {
    const products = db.prepare("SELECT id, name, price, category_id AS categoryId FROM products ORDER BY id").all();
    res.json(products);
  });

  app.get("/products/:id", (req, res) => {
    const product = db.prepare("SELECT id, name, price, category_id AS categoryId FROM products WHERE id = ?").get(Number(req.params.id));
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  });

  app.post("/users", (req, res) => {
    const { name, email } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "name and email are required" });
    }
    try {
      const result = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(name.trim(), email.trim());
      res.status(201).json({ id: Number(result.lastInsertRowid), name: name.trim(), email: email.trim() });
    } catch {
      res.status(409).json({ error: "Email already exists" });
    }
  });

  app.post("/coupons", (req, res) => {
    const { code, type, value, validFrom, validUntil, minimumAmount, categoryIds } = req.body ?? {};
    const from = couponDate(validFrom);
    const until = couponDate(validUntil, true);
    const valid = typeof code === "string" && Boolean(code.trim())
      && (type === "percentage" || type === "fixed")
      && typeof value === "number" && Number.isFinite(value) && value > 0
      && from && until && from <= until
      && typeof minimumAmount === "number" && Number.isFinite(minimumAmount) && minimumAmount >= 0
      && Array.isArray(categoryIds) && categoryIds.every(Number.isInteger)
      && new Set(categoryIds).size === categoryIds.length
      && (type !== "percentage" || value <= 100);
    if (!valid) return res.status(400).json({ error: "Invalid coupon" });

    const normalizedCode = code.trim();
    const missingCategory = categoryIds.some((id: number) => !db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id));
    if (missingCategory) return res.status(400).json({ error: "Invalid categoryIds" });
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO coupons (code, type, value, valid_from, valid_until, minimum_amount)
          VALUES (?, ?, ?, ?, ?, ?)`).run(normalizedCode, type, value, from.toISOString(), until.toISOString(), minimumAmount);
        const insertCategory = db.prepare("INSERT INTO coupon_categories (coupon_code, category_id) VALUES (?, ?)");
        for (const categoryId of categoryIds) insertCategory.run(normalizedCode, categoryId);
      })();
    } catch {
      return res.status(409).json({ error: "Coupon code already exists" });
    }
    res.status(201).json(couponWithCategories(normalizedCode));
  });

  app.get("/coupons/:code", (req, res) => {
    const coupon = couponWithCategories(req.params.code);
    if (!coupon) return res.status(404).json({ error: "Coupon not found" });
    res.json(coupon);
  });

  app.get("/cart/:userId", (req, res) => {
    const userId = Number(req.params.userId);
    if (!userExists(userId)) return res.status(404).json({ error: "User not found" });
    res.json({ userId, items: cart(userId) });
  });

  app.post("/cart/:userId/items", (req, res) => {
    const userId = Number(req.params.userId);
    const { productId, quantity } = req.body ?? {};
    if (!userExists(userId)) return res.status(404).json({ error: "User not found" });
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "productId and a positive integer quantity are required" });
    }
    if (!db.prepare("SELECT 1 FROM products WHERE id = ?").get(productId)) return res.status(404).json({ error: "Product not found" });
    db.prepare(`INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity`).run(userId, productId, quantity);
    res.status(201).json({ userId, items: cart(userId) });
  });

  app.post("/checkout/:userId", (req, res) => {
    const userId = Number(req.params.userId);
    const { couponCode } = req.body ?? {};
    if (!userExists(userId)) return res.status(404).json({ error: "User not found" });
    if (couponCode !== undefined && (typeof couponCode !== "string" || !couponCode.trim())) {
      return res.status(400).json({ error: "Invalid couponCode" });
    }
    const checkout = db.transaction(() => {
      const items = checkoutCart(userId);
      if (items.length === 0) return null;
      const subtotal = money(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
      let coupon: Coupon | undefined;
      let discount = 0;
      if (couponCode) {
        const fullCoupon = couponWithCategories(couponCode.trim());
        const now = clock.now();
        if (!fullCoupon || now < new Date(fullCoupon.validFrom) || now > new Date(fullCoupon.validUntil)) {
          return { error: "Coupon is not valid" };
        }
        if (subtotal < fullCoupon.minimumAmount) return { error: "Coupon minimum amount not reached" };
        if (db.prepare("SELECT 1 FROM coupon_usages WHERE coupon_code = ? AND user_id = ?").get(fullCoupon.code, userId)) {
          return { error: "Coupon already used by this user" };
        }
        const applicableItems = fullCoupon.categoryIds.length === 0
          ? items
          : items.filter((item) => fullCoupon.categoryIds.includes(item.categoryId));
        const applicableAmount = money(applicableItems.reduce((sum, item) => sum + item.price * item.quantity, 0));
        if (applicableAmount === 0) return { error: "Coupon does not apply to cart items" };
        discount = fullCoupon.type === "percentage" ? money(applicableAmount * fullCoupon.value / 100) : Math.min(fullCoupon.value, applicableAmount);
        discount = money(discount);
        coupon = fullCoupon;
      }
      const total = money(subtotal - discount);
      const result = db.prepare("INSERT INTO orders (user_id, subtotal, discount, total, coupon_code, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(userId, subtotal, discount, total, coupon?.code ?? null, toSqliteTimestamp(clock.now()));
      if (coupon) db.prepare("INSERT INTO coupon_usages (coupon_code, user_id, order_id, used_at) VALUES (?, ?, ?, ?)")
        .run(coupon.code, userId, Number(result.lastInsertRowid), toSqliteTimestamp(clock.now()));
      db.prepare("DELETE FROM cart_items WHERE user_id = ?").run(userId);
      return coupon
        ? { id: Number(result.lastInsertRowid), userId, subtotal, discount, total, couponCode: coupon.code }
        : { id: Number(result.lastInsertRowid), userId, subtotal, total };
    });
    const order = checkout();
    if (!order) return res.status(400).json({ error: "Cart is empty" });
    if ("error" in order) return res.status(400).json({ error: order.error });
    res.status(201).json(order);
  });

  return app;
}
