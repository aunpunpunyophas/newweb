"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();


const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, "orders.db");
const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || "admin";
const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ORDER_STATUSES = new Set(["pending", "preparing", "served", "cancelled"]);

const db = new sqlite3.Database(DB_PATH);
const app = express();
const sessions = new Map();
const sseClients = new Set();

app.use(express.json({ limit: "1mb" }));

function run(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function all(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function hashPassword(password, salt) {
  const currentSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password || ""), currentSalt, 100000, 64, "sha512").toString("hex");
  return currentSalt + "$" + hash;
}

function verifyPassword(password, hashed) {
  if (!hashed || hashed.indexOf("$") === -1) {
    return false;
  }
  const parts = hashed.split("$");
  const salt = parts[0];
  const expectedHash = parts[1];
  if (!salt || !expectedHash) {
    return false;
  }
  const actualHash = hashPassword(password, salt).split("$")[1];
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const actualBuffer = Buffer.from(actualHash, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function createSession(admin) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    adminId: admin.id,
    username: admin.username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function authMiddleware(req, res, next) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = getSession(token);

  if (!session) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  req.admin = session;
  req.adminToken = token;
  next();
}

function sanitizeText(value, maxLen) {
  const clean = String(value || "").trim();
  if (!maxLen) {
    return clean;
  }
  return clean.slice(0, maxLen);
}

function normalizeItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      const name = sanitizeText(item && item.name, 120);
      const price = Math.max(0, Math.round(Number(item && item.price) || 0));
      const qty = Math.max(1, Math.min(99, Math.round(Number(item && item.qty) || 1)));
      const image = sanitizeText(item && item.image, 2048);
      return { name, price, qty, image };
    })
    .filter((item) => item.name);
}

async function getOrderById(orderId) {
  const order = await get(
    `SELECT id, customer_name AS customerName, table_no AS tableNo, note, status, total, created_at AS createdAt, updated_at AS updatedAt
     FROM orders
     WHERE id = ?`,
    [orderId]
  );
  if (!order) {
    return null;
  }

  order.items = await all(
    `SELECT id, name, price, qty, image
     FROM order_items
     WHERE order_id = ?
     ORDER BY id ASC`,
    [orderId]
  );
  return order;
}

async function getAllOrdersWithItems() {
  const orders = await all(
    `SELECT id, customer_name AS customerName, table_no AS tableNo, note, status, total, created_at AS createdAt, updated_at AS updatedAt
     FROM orders
     ORDER BY id DESC`
  );

  let i;
  for (i = 0; i < orders.length; i += 1) {
    orders[i].items = await all(
      `SELECT id, name, price, qty, image
       FROM order_items
       WHERE order_id = ?
       ORDER BY id ASC`,
      [orders[i].id]
    );
  }

  return orders;
}

function sendSse(res, event, payload) {
  if (event) {
    res.write("event: " + event + "\n");
  }
  res.write("data: " + JSON.stringify(payload) + "\n\n");
}

function broadcast(event, payload) {
  sseClients.forEach((client) => {
    if (!getSession(client.token)) {
      sseClients.delete(client);
      try {
        client.res.end();
      } catch (endError) {
        // no-op
      }
      return;
    }

    try {
      sendSse(client.res, event, payload);
    } catch (error) {
      sseClients.delete(client);
      try {
        client.res.end();
      } catch (endError) {
        // no-op
      }
    }
  });
}

async function initDatabase() {
  await run("PRAGMA foreign_keys = ON;");

  await run(
    `CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL DEFAULT 'ลูกค้า',
      table_no TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      qty INTEGER NOT NULL DEFAULT 1,
      image TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
    );`
  );

  const existingAdmin = await get("SELECT id FROM admins WHERE username = ?", [DEFAULT_ADMIN_USER]);
  if (!existingAdmin) {
    await run("INSERT INTO admins (username, password_hash) VALUES (?, ?)", [
      DEFAULT_ADMIN_USER,
      hashPassword(DEFAULT_ADMIN_PASS)
    ]);
    console.log("Seeded admin user:", DEFAULT_ADMIN_USER, "/ password:", DEFAULT_ADMIN_PASS);
  }
}

app.post("/api/orders", async (req, res) => {
  const customerName = sanitizeText(req.body && req.body.customerName, 80) || "ลูกค้า";
  const tableNo = sanitizeText(req.body && req.body.tableNo, 60);
  const note = sanitizeText(req.body && req.body.note, 300);
  const items = normalizeItems(req.body && req.body.items);

  if (!items.length) {
    res.status(400).json({ message: "ไม่มีรายการสินค้าในออเดอร์" });
    return;
  }

  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  let orderId = null;

  try {
    await run("BEGIN TRANSACTION;");

    const result = await run(
      `INSERT INTO orders (customer_name, table_no, note, status, total, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))`,
      [customerName, tableNo, note, total]
    );
    orderId = result.lastID;

    let i;
    for (i = 0; i < items.length; i += 1) {
      await run(
        `INSERT INTO order_items (order_id, name, price, qty, image)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, items[i].name, items[i].price, items[i].qty, items[i].image]
      );
    }

    await run("COMMIT;");

    const order = await getOrderById(orderId);
    broadcast("order", { type: "order_created", order });

    res.status(201).json({
      message: "สร้างออเดอร์สำเร็จ",
      orderId,
      total
    });
  } catch (error) {
    try {
      await run("ROLLBACK;");
    } catch (rollbackError) {
      // no-op
    }
    console.error("Failed to create order:", error);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการบันทึกออเดอร์" });
  }
});

app.post("/api/admin/login", async (req, res) => {
  const username = sanitizeText(req.body && req.body.username, 80);
  const password = String((req.body && req.body.password) || "");

  if (!username || !password) {
    res.status(400).json({ message: "กรอกชื่อผู้ใช้และรหัสผ่าน" });
    return;
  }

  try {
    const admin = await get("SELECT id, username, password_hash AS passwordHash FROM admins WHERE username = ?", [username]);
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      res.status(401).json({ message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
      return;
    }

    const token = createSession(admin);
    res.json({
      message: "เข้าสู่ระบบสำเร็จ",
      token,
      admin: { id: admin.id, username: admin.username },
      expiresInMs: SESSION_TTL_MS
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "ไม่สามารถเข้าสู่ระบบได้" });
  }
});

app.get("/api/admin/orders", authMiddleware, async (req, res) => {
  try {
    const orders = await getAllOrdersWithItems();
    res.json({ orders });
  } catch (error) {
    console.error("Fetch orders error:", error);
    res.status(500).json({ message: "ไม่สามารถดึงรายการออเดอร์ได้" });
  }
});

app.patch("/api/admin/orders/:id/status", authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);
  const nextStatus = sanitizeText(req.body && req.body.status, 40).toLowerCase();

  if (!Number.isInteger(orderId) || orderId <= 0) {
    res.status(400).json({ message: "order id ไม่ถูกต้อง" });
    return;
  }

  if (!ORDER_STATUSES.has(nextStatus)) {
    res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
    return;
  }

  try {
    const result = await run(
      `UPDATE orders
       SET status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [nextStatus, orderId]
    );

    if (!result.changes) {
      res.status(404).json({ message: "ไม่พบออเดอร์" });
      return;
    }

    const order = await getOrderById(orderId);
    broadcast("order", { type: "order_updated", order });
    res.json({ message: "อัปเดตสถานะสำเร็จ", order });
  } catch (error) {
    console.error("Update order status error:", error);
    res.status(500).json({ message: "อัปเดตสถานะไม่สำเร็จ" });
  }
});

app.get("/api/admin/orders/stream", (req, res) => {
  const token = sanitizeText(req.query && req.query.token, 200);
  const session = getSession(token);

  if (!session) {
    res.status(401).end("Unauthorized");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const client = { res, token };
  sseClients.add(client);
  sendSse(res, "ready", { ok: true, now: Date.now() });

  req.on("close", () => {
    sseClients.delete(client);
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.get("/admin", (req, res) => {
  res.redirect("/admin.html");
});

app.use(express.static(__dirname));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "เกิดข้อผิดพลาดในระบบ" });
});

setInterval(() => {
  const now = Date.now();
  sessions.forEach((value, key) => {
    if (value.expiresAt < now) {
      sessions.delete(key);
    }
  });
  broadcast("ping", { now });
}, 25000).unref();

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server running on http://localhost:" + PORT);
    });
  })
  .catch((error) => {
    console.error("Failed to init database:", error);
    process.exit(1);
  });
// กฟไกฟไกไฟกไฟ กไฟ กไฟ ฟำ