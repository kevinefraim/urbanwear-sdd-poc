import express from "express";
import { createClock, toSqliteTimestamp, type Clock } from "./clock.js";
import type { Db } from "./db.js";

type Product = { id: number; name: string; price: number; categoryId: number };
type Coupon = {
  id: number;
  code: string;
  type: "percentage" | "fixed";
  value: number;
  validFrom: string;
  validUntil: string;
  minimumAmount: number;
  categoryIds: number[];
};

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

export function createApp(db: Db, clock: Clock = createClock()) {
  const app = express();
  app.use(express.json());

  const userExists = (id: number) => Boolean(db.prepare("SELECT 1 FROM users WHERE id = ?").get(id));
  const cart = (userId: number) => db.prepare(`
    SELECT p.id AS productId, p.name, p.price, ci.quantity
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ? ORDER BY p.id
  `).all(userId);
  const checkoutItems = (userId: number) => db.prepare(`
    SELECT p.price, p.category_id AS categoryId, ci.quantity
    FROM cart_items ci JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ? ORDER BY p.id
  `).all(userId) as Array<{ price: number; categoryId: number; quantity: number }>;
  const couponByCode = (code: string): Coupon | undefined => {
    const row = db.prepare(`
      SELECT id, code, type, value, valid_from AS validFrom,
             valid_until AS validUntil, minimum_amount AS minimumAmount
      FROM coupons WHERE code = ?
    `).get(code) as Omit<Coupon, "categoryIds"> | undefined;
    if (!row) return undefined;
    const categoryIds = db.prepare("SELECT category_id AS id FROM coupon_categories WHERE coupon_id = ? ORDER BY category_id")
      .all(row.id) as Array<{ id: number }>;
    return { ...row, categoryIds: categoryIds.map((category) => category.id) };
  };
  const parseTimestamp = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
    const normalizedCode = typeof code === "string" ? code.trim() : "";
    const from = parseTimestamp(validFrom);
    const until = parseTimestamp(validUntil);
    const validCategories = Array.isArray(categoryIds) && categoryIds.every(Number.isInteger);
    const distinctCategoryIds = validCategories ? [...new Set(categoryIds as number[])] : [];
    if (!normalizedCode || (type !== "percentage" && type !== "fixed") || !Number.isFinite(value) || value <= 0 ||
      (type === "percentage" && (value < 1 || value > 100)) ||
      !from || !until || from > until || !Number.isFinite(minimumAmount) || minimumAmount < 0 || !validCategories) {
      return res.status(400).json({ error: "Invalid coupon fields" });
    }
    const categoryCount = distinctCategoryIds.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS count FROM categories WHERE id IN (${distinctCategoryIds.map(() => "?").join(",")})`)
      .get(...distinctCategoryIds) as { count: number }).count;
    if (categoryCount !== distinctCategoryIds.length) return res.status(400).json({ error: "One or more categories do not exist" });
    try {
      const createCoupon = db.transaction(() => {
        const result = db.prepare(`INSERT INTO coupons (code, type, value, valid_from, valid_until, minimum_amount)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(normalizedCode, type, value, from, until, minimumAmount);
        const couponId = Number(result.lastInsertRowid);
        const addCategory = db.prepare("INSERT INTO coupon_categories (coupon_id, category_id) VALUES (?, ?)");
        for (const categoryId of distinctCategoryIds) addCategory.run(couponId, categoryId);
        return couponByCode(normalizedCode)!;
      });
      res.status(201).json(createCoupon());
    } catch {
      res.status(409).json({ error: "Coupon code already exists" });
    }
  });

  app.get("/coupons/:code", (req, res) => {
    const coupon = couponByCode(req.params.code);
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
    if (!userExists(userId)) return res.status(404).json({ error: "User not found" });
    const suppliedCouponCode = req.body?.couponCode;
    if (suppliedCouponCode !== undefined && (typeof suppliedCouponCode !== "string" || !suppliedCouponCode.trim())) {
      return res.status(400).json({ error: "couponCode must be a non-empty string" });
    }
    const requestedCouponCode = typeof suppliedCouponCode === "string" ? suppliedCouponCode.trim() : undefined;
    const checkout = db.transaction(() => {
      const items = checkoutItems(userId);
      if (items.length === 0) return null;
      const subtotal = roundMoney(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
      let discount = 0;
      let coupon: Coupon | undefined;
      if (requestedCouponCode) {
        coupon = couponByCode(requestedCouponCode);
        if (!coupon) throw new Error("Coupon not found");
        const now = clock.now().getTime();
        const validFrom = new Date(coupon.validFrom).getTime();
        const validUntil = new Date(coupon.validUntil).getTime();
        if (now < validFrom || now > validUntil) throw new Error("Coupon is not currently valid");
        if (db.prepare("SELECT 1 FROM coupon_usages WHERE coupon_id = ? AND user_id = ?").get(coupon.id, userId)) {
          throw new Error("Coupon has already been used by this user");
        }
        if (subtotal < coupon.minimumAmount) throw new Error("Cart does not meet coupon minimum amount");
        const eligibleSubtotal = roundMoney(items.reduce((sum, item) =>
          coupon!.categoryIds.length === 0 || coupon!.categoryIds.includes(item.categoryId)
            ? sum + item.price * item.quantity : sum, 0));
        if (eligibleSubtotal === 0) throw new Error("Cart has no items eligible for this coupon");
        discount = coupon.type === "percentage"
          ? roundMoney(eligibleSubtotal * coupon.value / 100)
          : roundMoney(Math.min(coupon.value, eligibleSubtotal));
      }
      const total = roundMoney(Math.max(0, subtotal - discount));
      const result = db.prepare("INSERT INTO orders (user_id, subtotal, total, created_at) VALUES (?, ?, ?, ?)")
        .run(userId, subtotal, total, toSqliteTimestamp(clock.now()));
      const orderId = Number(result.lastInsertRowid);
      if (coupon) db.prepare("INSERT INTO coupon_usages (coupon_id, user_id, order_id) VALUES (?, ?, ?)").run(coupon.id, userId, orderId);
      db.prepare("DELETE FROM cart_items WHERE user_id = ?").run(userId);
      return coupon
        ? { id: orderId, userId, subtotal, discount, total, couponCode: coupon.code }
        : { id: orderId, userId, subtotal, total };
    });
    let order;
    try {
      order = checkout();
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Coupon could not be applied" });
    }
    if (!order) return res.status(400).json({ error: "Cart is empty" });
    res.status(201).json(order);
  });

  return app;
}
