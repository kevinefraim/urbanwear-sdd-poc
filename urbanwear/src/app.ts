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
  allowedUserIds: number[];
  active: boolean;
  maxUsesPerUser: number;
};

const MAX_COUPON_USES_PER_USER_PER_UTC_DAY = 1;
type CouponPatch = Partial<Omit<Coupon, "id" | "code">>;

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function utcDayBounds(date: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
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
  const couponByCode = (code: string, at = clock.now()): Coupon | undefined => {
    const row = db.prepare(`
      SELECT id, code, type, value, valid_from AS validFrom,
             valid_until AS validUntil, minimum_amount AS minimumAmount,
             active, max_uses_per_user AS maxUsesPerUser
      FROM coupons WHERE code = ?
    `).get(code) as Omit<Coupon, "categoryIds" | "allowedUserIds"> | undefined;
    if (!row) return undefined;
    const categoryIds = db.prepare("SELECT category_id AS id FROM coupon_categories WHERE coupon_id = ? ORDER BY category_id")
      .all(row.id) as Array<{ id: number }>;
    const allowedUserIds = db.prepare("SELECT user_id AS id FROM coupon_allowed_users WHERE coupon_id = ? ORDER BY user_id")
      .all(row.id) as Array<{ id: number }>;
    let coupon: Coupon = {
      ...row,
      active: Boolean(row.active),
      categoryIds: categoryIds.map((category) => category.id),
      allowedUserIds: allowedUserIds.map((user) => user.id),
    };
    const revisions = db.prepare(`SELECT patch_json AS patchJson FROM coupon_revisions
      WHERE coupon_id = ? AND effective_from <= ? ORDER BY effective_from, id`).all(row.id, at.toISOString()) as Array<{ patchJson: string }>;
    for (const revision of revisions) {
      coupon = { ...coupon, ...JSON.parse(revision.patchJson) as CouponPatch };
    }
    return coupon;
  };
  const parseTimestamp = (value: unknown, endOfDay = false): string | undefined => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const date = new Date(dateOnly && endOfDay ? `${value}T23:59:59.999Z` : value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  const validCouponConfiguration = (coupon: Omit<Coupon, "id" | "code">): boolean =>
    (coupon.type === "percentage" || coupon.type === "fixed") && Number.isFinite(coupon.value) && coupon.value > 0 &&
    (coupon.type !== "percentage" || (coupon.value >= 1 && coupon.value <= 100)) &&
    Boolean(parseTimestamp(coupon.validFrom)) && Boolean(parseTimestamp(coupon.validUntil, true)) &&
    coupon.validFrom <= coupon.validUntil && Number.isFinite(coupon.minimumAmount) && coupon.minimumAmount >= 0 &&
    typeof coupon.active === "boolean" && Number.isInteger(coupon.maxUsesPerUser) && coupon.maxUsesPerUser > 0;

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
    const { code, type, value, validFrom, validUntil, minimumAmount, categoryIds, allowedUserIds, active = true, maxUsesPerUser = 3 } = req.body ?? {};
    const normalizedCode = typeof code === "string" ? code.trim() : "";
    const from = parseTimestamp(validFrom);
    const until = parseTimestamp(validUntil, true);
    const validCategories = Array.isArray(categoryIds) && categoryIds.every(Number.isInteger);
    const distinctCategoryIds = validCategories ? [...new Set(categoryIds as number[])] : [];
    const validAllowedUsers = allowedUserIds === undefined || (Array.isArray(allowedUserIds) && allowedUserIds.every(Number.isInteger));
    const distinctAllowedUserIds = allowedUserIds === undefined ? [] : [...new Set(allowedUserIds as number[])];
    if (!normalizedCode || (type !== "percentage" && type !== "fixed") || !Number.isFinite(value) || value <= 0 ||
      (type === "percentage" && (value < 1 || value > 100)) ||
      !from || !until || from > until || !Number.isFinite(minimumAmount) || minimumAmount < 0 || !validCategories || !validAllowedUsers ||
      typeof active !== "boolean" || !Number.isInteger(maxUsesPerUser) || maxUsesPerUser <= 0) {
      return res.status(400).json({ error: "Invalid coupon fields" });
    }
    const categoryCount = distinctCategoryIds.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS count FROM categories WHERE id IN (${distinctCategoryIds.map(() => "?").join(",")})`)
      .get(...distinctCategoryIds) as { count: number }).count;
    if (categoryCount !== distinctCategoryIds.length) return res.status(400).json({ error: "One or more categories do not exist" });
    const allowedUserCount = distinctAllowedUserIds.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS count FROM users WHERE id IN (${distinctAllowedUserIds.map(() => "?").join(",")})`)
      .get(...distinctAllowedUserIds) as { count: number }).count;
    if (allowedUserCount !== distinctAllowedUserIds.length) return res.status(400).json({ error: "One or more allowed users do not exist" });
    try {
      const createCoupon = db.transaction(() => {
        const result = db.prepare(`INSERT INTO coupons (code, type, value, valid_from, valid_until, minimum_amount, active, max_uses_per_user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(normalizedCode, type, value, from, until, minimumAmount, active ? 1 : 0, maxUsesPerUser);
        const couponId = Number(result.lastInsertRowid);
        const addCategory = db.prepare("INSERT INTO coupon_categories (coupon_id, category_id) VALUES (?, ?)");
        for (const categoryId of distinctCategoryIds) addCategory.run(couponId, categoryId);
        const addAllowedUser = db.prepare("INSERT INTO coupon_allowed_users (coupon_id, user_id) VALUES (?, ?)");
        for (const userId of distinctAllowedUserIds) addAllowedUser.run(couponId, userId);
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

  app.patch("/coupons/:code", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Invalid coupon fields" });
    const editable = ["type", "value", "validFrom", "validUntil", "minimumAmount", "categoryIds", "allowedUserIds", "active", "maxUsesPerUser"] as const;
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => key !== "effectiveFrom" && !editable.includes(key as typeof editable[number]))) {
      return res.status(400).json({ error: "Invalid coupon fields" });
    }
    const patch: CouponPatch = {};
    if ("type" in body) patch.type = body.type;
    if ("value" in body) patch.value = body.value;
    if ("validFrom" in body) {
      const timestamp = parseTimestamp(body.validFrom);
      if (!timestamp) return res.status(400).json({ error: "Invalid coupon fields" });
      patch.validFrom = timestamp;
    }
    if ("validUntil" in body) {
      const timestamp = parseTimestamp(body.validUntil, true);
      if (!timestamp) return res.status(400).json({ error: "Invalid coupon fields" });
      patch.validUntil = timestamp;
    }
    if ("minimumAmount" in body) patch.minimumAmount = body.minimumAmount;
    if ("active" in body) patch.active = body.active;
    if ("maxUsesPerUser" in body) patch.maxUsesPerUser = body.maxUsesPerUser;
    for (const field of ["categoryIds", "allowedUserIds"] as const) {
      if (!(field in body)) continue;
      const values = body[field];
      if (!Array.isArray(values) || !values.every(Number.isInteger)) return res.status(400).json({ error: "Invalid coupon fields" });
      patch[field] = [...new Set(values)] as never;
    }
    const effectiveFrom = "effectiveFrom" in body ? parseTimestamp(body.effectiveFrom) : clock.now().toISOString();
    if (!effectiveFrom) return res.status(400).json({ error: "Invalid coupon fields" });
    const existing = couponByCode(req.params.code, new Date(effectiveFrom));
    if (!existing) return res.status(404).json({ error: "Coupon not found" });
    const categoryIds = patch.categoryIds;
    if (categoryIds && categoryIds.length > 0) {
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM categories WHERE id IN (${categoryIds.map(() => "?").join(",")})`).get(...categoryIds) as { count: number }).count;
      if (count !== categoryIds.length) return res.status(400).json({ error: "One or more categories do not exist" });
    }
    const allowedUserIds = patch.allowedUserIds;
    if (allowedUserIds && allowedUserIds.length > 0) {
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM users WHERE id IN (${allowedUserIds.map(() => "?").join(",")})`).get(...allowedUserIds) as { count: number }).count;
      if (count !== allowedUserIds.length) return res.status(400).json({ error: "One or more allowed users do not exist" });
    }
    let candidate = { ...existing, ...patch };
    if (!validCouponConfiguration(candidate)) return res.status(400).json({ error: "Invalid coupon fields" });
    // A newly inserted past/future revision must not make a later stored revision invalid.
    const laterRevisions = db.prepare(`SELECT patch_json AS patchJson FROM coupon_revisions
      WHERE coupon_id = ? AND effective_from > ? ORDER BY effective_from, id`).all(existing.id, effectiveFrom) as Array<{ patchJson: string }>;
    for (const revision of laterRevisions) {
      candidate = { ...candidate, ...JSON.parse(revision.patchJson) as CouponPatch };
      if (!validCouponConfiguration(candidate)) return res.status(400).json({ error: "Invalid coupon fields" });
    }
    db.prepare("INSERT INTO coupon_revisions (coupon_id, effective_from, patch_json) VALUES (?, ?, ?)")
      .run(existing.id, effectiveFrom, JSON.stringify(patch));
    res.json(couponByCode(req.params.code)!);
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
      let couponUsedAt: Date | undefined;
      if (requestedCouponCode) {
        couponUsedAt = clock.now();
        coupon = couponByCode(requestedCouponCode, couponUsedAt);
        if (!coupon) throw new Error("Coupon not found");
        const now = couponUsedAt.getTime();
        const validFrom = new Date(coupon.validFrom).getTime();
        const validUntil = new Date(coupon.validUntil).getTime();
        if (now < validFrom || now > validUntil) throw new Error("Coupon is not currently valid");
        if (!coupon.active) throw new Error("Coupon is not currently active");
        if (coupon.allowedUserIds.length > 0 && !coupon.allowedUserIds.includes(userId)) {
          throw new Error("Coupon is not available for this user");
        }
        const totalUsages = db.prepare("SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_id = ? AND user_id = ?")
          .get(coupon.id, userId) as { count: number };
        if (totalUsages.count >= coupon.maxUsesPerUser) {
          throw new Error("Coupon usage limit reached for this user");
        }
        const day = utcDayBounds(couponUsedAt);
        const dailyUsages = db.prepare(`SELECT COUNT(*) AS count FROM coupon_usages
          WHERE coupon_id = ? AND user_id = ? AND used_at >= ? AND used_at < ?`)
          .get(coupon.id, userId, day.start, day.end) as { count: number };
        if (dailyUsages.count >= MAX_COUPON_USES_PER_USER_PER_UTC_DAY) {
          throw new Error("Coupon daily usage limit reached for this user");
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
      if (coupon) db.prepare("INSERT INTO coupon_usages (coupon_id, user_id, order_id, used_at) VALUES (?, ?, ?, ?)")
        .run(coupon.id, userId, orderId, couponUsedAt!.toISOString());
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
