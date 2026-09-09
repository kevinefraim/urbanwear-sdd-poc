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
  active: boolean;
  maxUsesPerUser: number;
};
type CouponWithEligibility = Coupon & { categoryIds: number[]; allowedUserIds?: number[] };
type CouponConfig = Coupon & { categoryIds: number[]; allowedUserIds: number[] };
type CouponChanges = Partial<Omit<Coupon, "code">> & Pick<Partial<CouponConfig>, "categoryIds" | "allowedUserIds">;

const money = (amount: number) => Number(amount.toFixed(2));
const MAX_COUPON_USES_PER_USER = 3;
const MAX_COUPON_USES_PER_USER_PER_UTC_DAY = 1;
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

  const couponConfig = (code: string): CouponConfig | undefined => {
    const coupon = db.prepare(`SELECT code, type, value, valid_from AS validFrom,
      valid_until AS validUntil, minimum_amount AS minimumAmount, active,
      max_uses_per_user AS maxUsesPerUser FROM coupons WHERE code = ?`).get(code) as (Omit<Coupon, "active"> & { active: number }) | undefined;
    if (!coupon) return undefined;
    const categoryIds = (db.prepare("SELECT category_id AS categoryId FROM coupon_categories WHERE coupon_code = ? ORDER BY category_id")
      .all(code) as Array<{ categoryId: number }>).map(({ categoryId }) => categoryId);
    const allowedUserIds = (db.prepare("SELECT user_id AS userId FROM coupon_allowed_users WHERE coupon_code = ? ORDER BY user_id")
      .all(code) as Array<{ userId: number }>).map(({ userId }) => userId);
    return { ...coupon, active: Boolean(coupon.active), categoryIds, allowedUserIds };
  };

  const couponWithEligibility = (code: string): CouponWithEligibility | undefined => {
    applyScheduledUpdates(code);
    const coupon = couponConfig(code);
    if (!coupon) return undefined;
    const { allowedUserIds, ...withoutAllowedUsers } = coupon;
    return allowedUserIds.length > 0 ? coupon : withoutAllowedUsers;
  };

  const validCouponConfig = (coupon: CouponConfig): boolean => coupon.type === "percentage" || coupon.type === "fixed"
    ? Number.isFinite(coupon.value) && coupon.value > 0
      && (coupon.type !== "percentage" || coupon.value <= 100)
      && !Number.isNaN(new Date(coupon.validFrom).getTime())
      && !Number.isNaN(new Date(coupon.validUntil).getTime())
      && new Date(coupon.validFrom) <= new Date(coupon.validUntil)
      && Number.isFinite(coupon.minimumAmount) && coupon.minimumAmount >= 0
      && typeof coupon.active === "boolean"
      && Number.isInteger(coupon.maxUsesPerUser) && coupon.maxUsesPerUser >= 0
      && Array.isArray(coupon.categoryIds) && new Set(coupon.categoryIds).size === coupon.categoryIds.length
      && Array.isArray(coupon.allowedUserIds) && new Set(coupon.allowedUserIds).size === coupon.allowedUserIds.length
    : false;

  const saveCouponChanges = (code: string, changes: CouponChanges) => {
    const fields: Array<[string, unknown]> = [];
    if (changes.type !== undefined) fields.push(["type", changes.type]);
    if (changes.value !== undefined) fields.push(["value", changes.value]);
    if (changes.validFrom !== undefined) fields.push(["valid_from", changes.validFrom]);
    if (changes.validUntil !== undefined) fields.push(["valid_until", changes.validUntil]);
    if (changes.minimumAmount !== undefined) fields.push(["minimum_amount", changes.minimumAmount]);
    if (changes.active !== undefined) fields.push(["active", changes.active ? 1 : 0]);
    if (changes.maxUsesPerUser !== undefined) fields.push(["max_uses_per_user", changes.maxUsesPerUser]);
    if (fields.length > 0) {
      db.prepare(`UPDATE coupons SET ${fields.map(([field]) => `${field} = ?`).join(", ")} WHERE code = ?`)
        .run(...fields.map(([, value]) => value), code);
    }
    if (changes.categoryIds !== undefined) {
      db.prepare("DELETE FROM coupon_categories WHERE coupon_code = ?").run(code);
      const insert = db.prepare("INSERT INTO coupon_categories (coupon_code, category_id) VALUES (?, ?)");
      for (const categoryId of changes.categoryIds) insert.run(code, categoryId);
    }
    if (changes.allowedUserIds !== undefined) {
      db.prepare("DELETE FROM coupon_allowed_users WHERE coupon_code = ?").run(code);
      const insert = db.prepare("INSERT INTO coupon_allowed_users (coupon_code, user_id) VALUES (?, ?)");
      for (const userId of changes.allowedUserIds) insert.run(code, userId);
    }
  };

  // Scheduled changes are materialized when a coupon is read or used. This keeps
  // checkout deterministic without a background worker and preserves usage history.
  const applyScheduledUpdates = (code: string) => {
    const due = db.prepare(`SELECT id, changes FROM coupon_scheduled_updates
      WHERE coupon_code = ? AND effective_from <= ? ORDER BY effective_from, id`)
      .all(code, clock.now().toISOString()) as Array<{ id: number; changes: string }>;
    if (due.length === 0) return;
    db.transaction(() => {
      for (const update of due) {
        saveCouponChanges(code, JSON.parse(update.changes) as CouponChanges);
        db.prepare("DELETE FROM coupon_scheduled_updates WHERE id = ?").run(update.id);
      }
    })();
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
    const { code, type, value, validFrom, validUntil, minimumAmount, categoryIds, allowedUserIds,
      active = true, maxUsesPerUser = MAX_COUPON_USES_PER_USER } = req.body ?? {};
    const from = couponDate(validFrom);
    const until = couponDate(validUntil, true);
    const valid = typeof code === "string" && Boolean(code.trim())
      && (type === "percentage" || type === "fixed")
      && typeof value === "number" && Number.isFinite(value) && value > 0
      && from && until && from <= until
      && typeof minimumAmount === "number" && Number.isFinite(minimumAmount) && minimumAmount >= 0
      && typeof active === "boolean"
      && Number.isInteger(maxUsesPerUser) && maxUsesPerUser >= 0
      && Array.isArray(categoryIds) && categoryIds.every(Number.isInteger)
      && new Set(categoryIds).size === categoryIds.length
      && (allowedUserIds === undefined || (Array.isArray(allowedUserIds)
        && allowedUserIds.every(Number.isInteger)
        && new Set(allowedUserIds).size === allowedUserIds.length))
      && (type !== "percentage" || value <= 100);
    if (!valid) return res.status(400).json({ error: "Invalid coupon" });

    const normalizedCode = code.trim();
    const missingCategory = categoryIds.some((id: number) => !db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id));
    if (missingCategory) return res.status(400).json({ error: "Invalid categoryIds" });
    const missingUser = allowedUserIds?.some((id: number) => !userExists(id));
    if (missingUser) return res.status(400).json({ error: "Invalid allowedUserIds" });
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO coupons (code, type, value, valid_from, valid_until, minimum_amount, active, max_uses_per_user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(normalizedCode, type, value, from.toISOString(), until.toISOString(), minimumAmount,
          active ? 1 : 0, maxUsesPerUser);
        const insertCategory = db.prepare("INSERT INTO coupon_categories (coupon_code, category_id) VALUES (?, ?)");
        for (const categoryId of categoryIds) insertCategory.run(normalizedCode, categoryId);
        const insertAllowedUser = db.prepare("INSERT INTO coupon_allowed_users (coupon_code, user_id) VALUES (?, ?)");
        for (const allowedUserId of allowedUserIds ?? []) insertAllowedUser.run(normalizedCode, allowedUserId);
      })();
    } catch {
      return res.status(409).json({ error: "Coupon code already exists" });
    }
    res.status(201).json(couponWithEligibility(normalizedCode));
  });

  app.patch("/coupons/:code", (req, res) => {
    const code = req.params.code;
    applyScheduledUpdates(code);
    const current = couponConfig(code);
    if (!current) return res.status(404).json({ error: "Coupon not found" });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "Invalid coupon update" });
    const allowedFields = new Set(["type", "value", "validFrom", "validUntil", "minimumAmount", "categoryIds", "allowedUserIds", "active", "maxUsesPerUser", "effectiveFrom"]);
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => !allowedFields.has(key))) return res.status(400).json({ error: "Invalid coupon update" });

    const changes: CouponChanges = {};
    if (Object.hasOwn(body, "type")) {
      if (body.type !== "percentage" && body.type !== "fixed") return res.status(400).json({ error: "Invalid coupon update" });
      changes.type = body.type;
    }
    if (Object.hasOwn(body, "value")) {
      if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value <= 0) return res.status(400).json({ error: "Invalid coupon update" });
      changes.value = body.value;
    }
    if (Object.hasOwn(body, "validFrom")) {
      const date = couponDate(body.validFrom);
      if (!date) return res.status(400).json({ error: "Invalid coupon update" });
      changes.validFrom = date.toISOString();
    }
    if (Object.hasOwn(body, "validUntil")) {
      const date = couponDate(body.validUntil, true);
      if (!date) return res.status(400).json({ error: "Invalid coupon update" });
      changes.validUntil = date.toISOString();
    }
    if (Object.hasOwn(body, "minimumAmount")) {
      if (typeof body.minimumAmount !== "number" || !Number.isFinite(body.minimumAmount) || body.minimumAmount < 0) return res.status(400).json({ error: "Invalid coupon update" });
      changes.minimumAmount = body.minimumAmount;
    }
    if (Object.hasOwn(body, "active")) {
      if (typeof body.active !== "boolean") return res.status(400).json({ error: "Invalid coupon update" });
      changes.active = body.active;
    }
    if (Object.hasOwn(body, "maxUsesPerUser")) {
      if (!Number.isInteger(body.maxUsesPerUser) || body.maxUsesPerUser < 0) return res.status(400).json({ error: "Invalid coupon update" });
      changes.maxUsesPerUser = body.maxUsesPerUser;
    }
    for (const field of ["categoryIds", "allowedUserIds"] as const) {
      if (!Object.hasOwn(body, field)) continue;
      const ids = body[field];
      if (!Array.isArray(ids) || !ids.every(Number.isInteger) || new Set(ids).size !== ids.length) return res.status(400).json({ error: "Invalid coupon update" });
      const exists = field === "categoryIds"
        ? ids.every((id: number) => db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id))
        : ids.every((id: number) => userExists(id));
      if (!exists) return res.status(400).json({ error: `Invalid ${field}` });
      changes[field] = ids;
    }
    if (Object.keys(changes).length === 0) return res.status(400).json({ error: "Invalid coupon update" });

    const effectiveFrom = Object.hasOwn(body, "effectiveFrom") ? couponDate(body.effectiveFrom) : undefined;
    if (Object.hasOwn(body, "effectiveFrom") && !effectiveFrom) return res.status(400).json({ error: "Invalid coupon update" });

    const scheduled = db.prepare("SELECT effective_from AS effectiveFrom, changes FROM coupon_scheduled_updates WHERE coupon_code = ? ORDER BY effective_from, id")
      .all(code) as Array<{ effectiveFrom: string; changes: string }>;
    const proposedAt = effectiveFrom ?? clock.now();
    const planned = [...scheduled.map((update) => ({ at: new Date(update.effectiveFrom), changes: JSON.parse(update.changes) as CouponChanges })),
      { at: proposedAt, changes }]
      .sort((left, right) => left.at.getTime() - right.at.getTime());
    let projected = current;
    for (const update of planned) {
      projected = { ...projected, ...update.changes,
        categoryIds: update.changes.categoryIds ?? projected.categoryIds,
        allowedUserIds: update.changes.allowedUserIds ?? projected.allowedUserIds };
      if (!validCouponConfig(projected)) return res.status(400).json({ error: "Invalid coupon update" });
    }

    if (effectiveFrom && effectiveFrom > clock.now()) {
      db.prepare("INSERT INTO coupon_scheduled_updates (coupon_code, effective_from, changes) VALUES (?, ?, ?)")
        .run(code, effectiveFrom.toISOString(), JSON.stringify(changes));
    } else {
      db.transaction(() => saveCouponChanges(code, changes))();
    }
    res.json(couponWithEligibility(code));
  });

  app.get("/coupons/:code", (req, res) => {
    const coupon = couponWithEligibility(req.params.code);
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
      const completedAt = clock.now();
      const subtotal = money(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
      let coupon: Coupon | undefined;
      let discount = 0;
      if (couponCode) {
        const fullCoupon = couponWithEligibility(couponCode.trim());
        const now = completedAt;
        if (!fullCoupon || !fullCoupon.active || now < new Date(fullCoupon.validFrom) || now > new Date(fullCoupon.validUntil)) {
          return { error: "Coupon is not valid" };
        }
        if (fullCoupon.allowedUserIds && !fullCoupon.allowedUserIds.includes(userId)) {
          return { error: "Coupon is not available for this user" };
        }
        if (subtotal < fullCoupon.minimumAmount) return { error: "Coupon minimum amount not reached" };
        const totalUses = db.prepare("SELECT COUNT(*) AS count FROM coupon_usages WHERE coupon_code = ? AND user_id = ?")
          .get(fullCoupon.code, userId) as { count: number };
        if (totalUses.count >= fullCoupon.maxUsesPerUser) return { error: "Coupon usage limit reached" };
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const dailyUses = db.prepare(`SELECT COUNT(*) AS count FROM coupon_usages
          WHERE coupon_code = ? AND user_id = ? AND used_at >= ? AND used_at < ?`)
          .get(fullCoupon.code, userId, toSqliteTimestamp(dayStart), toSqliteTimestamp(nextDayStart)) as { count: number };
        if (dailyUses.count >= MAX_COUPON_USES_PER_USER_PER_UTC_DAY) return { error: "Coupon daily usage limit reached" };
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
        .run(userId, subtotal, discount, total, coupon?.code ?? null, toSqliteTimestamp(completedAt));
      if (coupon) db.prepare("INSERT INTO coupon_usages (coupon_code, user_id, order_id, used_at) VALUES (?, ?, ?, ?)")
        .run(coupon.code, userId, Number(result.lastInsertRowid), toSqliteTimestamp(completedAt));
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
