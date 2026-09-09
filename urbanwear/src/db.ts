import Database from "better-sqlite3";
import { rmSync } from "node:fs";

export type Db = Database.Database;

export function createDatabase(filename = ":memory:"): Db {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL CHECK(price >= 0),
      category_id INTEGER NOT NULL REFERENCES categories(id)
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      PRIMARY KEY (user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      subtotal REAL NOT NULL,
      total REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('percentage', 'fixed')),
      value REAL NOT NULL CHECK(value > 0),
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      minimum_amount REAL NOT NULL CHECK(minimum_amount >= 0),
      CHECK(valid_from <= valid_until)
    );
    CREATE TABLE IF NOT EXISTS coupon_categories (
      coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      PRIMARY KEY (coupon_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS coupon_usages (
      coupon_id INTEGER NOT NULL REFERENCES coupons(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      PRIMARY KEY (coupon_id, user_id)
    );
  `);
  return db;
}

export function seedDatabase(db: Db): void {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (count.count > 0) return;

  const seed = db.transaction(() => {
    db.prepare("INSERT INTO categories (name) VALUES (?)").run("Zapatillas");
    db.prepare("INSERT INTO categories (name) VALUES (?)").run("Botines");
    const product = db.prepare("INSERT INTO products (name, price, category_id) VALUES (?, ?, ?)");
    product.run("Street Runner", 89.99, 1);
    product.run("Canvas High", 74.5, 1);
    product.run("Metro Low", 99.0, 1);
    product.run("Urban Boot", 129.99, 2);
    product.run("Classic Boot", 119.5, 2);
    const user = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)");
    user.run("Ana Pérez", "ana@example.com");
    user.run("Bruno Díaz", "bruno@example.com");
  });
  seed();
}

/** Recreates a file-backed database and loads the deterministic V0 seed. */
export function resetAndSeedDatabase(filename: string): Db {
  if (filename === ":memory:") {
    const db = createDatabase();
    seedDatabase(db);
    return db;
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${filename}${suffix}`, { force: true });
  const db = createDatabase(filename);
  seedDatabase(db);
  return db;
}
