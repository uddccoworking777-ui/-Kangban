// SQLite 資料庫（使用 Node.js 內建的 node:sqlite，不需要另外安裝資料庫）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'shop.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1,
  last_login TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL DEFAULT 0, icon TEXT, description TEXT, published INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, logo TEXT, sequence INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0, compare_price REAL, cost REAL,
  stock INTEGER NOT NULL DEFAULT 0, track_stock INTEGER NOT NULL DEFAULT 0,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  description TEXT, description_html TEXT, license_no TEXT,
  image TEXT, images TEXT NOT NULL DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 1, featured INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS product_categories (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id));

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT,
  phone TEXT, zip TEXT, city TEXT, street TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
  zip TEXT, city TEXT, street TEXT, cvs_store TEXT,
  shipping_method TEXT, shipping_fee REAL NOT NULL DEFAULT 0,
  payment_method TEXT, payment_status TEXT NOT NULL DEFAULT 'unpaid',
  status TEXT NOT NULL DEFAULT 'pending',
  invoice_type TEXT, invoice_detail TEXT, vat TEXT, company_name TEXT,
  note TEXT, admin_note TEXT, tracking_number TEXT,
  subtotal REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, access_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL, sku TEXT, price REAL NOT NULL, qty INTEGER NOT NULL, subtotal REAL NOT NULL);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, order_ref TEXT,
  message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', reply_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY, admin_id INTEGER, admin_name TEXT, action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

// ---------- 資料庫升級（舊資料庫自動補上新欄位） ----------
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('products', 'is_medical', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'license_holder', 'TEXT');
addColumn('products', 'manufacturer', 'TEXT');
addColumn('products', 'origin', 'TEXT');
addColumn('products', 'spec', 'TEXT');
addColumn('products', 'size_chart', 'TEXT');
addColumn('products', 'precautions', 'TEXT');
addColumn('products', 'sold_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'paid_at', 'TEXT');
addColumn('orders', 'shipped_at', 'TEXT');



// ---------- 小工具 ----------
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt] = stored.split(':');
  const a = Buffer.from(hashPassword(pw, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 網站設定 ----------
const DEFAULT_SETTINGS = {
  store_name: '康伴',
  company_name: '【公司全名】',
  founded_year: '【年份】',
  tax_id: '【統一編號】',
  license_no: '【執照字號】',
  address: '【地址】',
  phone: '【電話】',
  email: '【Email】',
  line_id: '【@LINE ID】',
  line_url: '',
  facebook_url: '',
  instagram_url: '',
  service_hours: '週一至週五 上午 9:00–下午 6:00',
  reply_days: '1',
  partner_brands_text: '【品牌／代理商名稱】',
  shipping_home: '100',
  shipping_cvs: '60',
  free_shipping_threshold: '1500',
  ship_days: '1–3',
  delivery_days: '1–2',
  payment_deadline_days: '3',
  refund_days: '7',
  bank_info: '銀行：【銀行名稱與代碼】\n帳號：【帳號】\n戶名：【戶名】',
  low_stock_threshold: '5',
  announcement: '全館單筆滿 NT$1,500 免運｜到貨享 7 天鑑賞期｜醫療器材皆具衛福部許可證',
  fda_lookup_url: 'https://info.fda.gov.tw/MLMS/H0001.aspx',
  hot_keywords: '護膝,護腰,助眠,運動襪,護腕',
  google_api_key: '',
  google_service_account: '',
  google_sheet_url: '',
  google_sheet_range: '',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);

let settingsCache = null;
function settings() {
  if (!settingsCache) settingsCache = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  return settingsCache;
}
function saveSettings(vals) {
  tx(() => {
    for (const [k, v] of Object.entries(vals)) run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v ?? ''));
  });
  settingsCache = null;
}

const DEFAULT_PRECAUTIONS = '使用前請詳閱說明書及注意事項。\n皮膚有傷口、紅腫或過敏時請暫停使用。\n如有身體不適，請諮詢醫師或藥師。';

// ---------- 第一次啟動：匯入示範資料 ----------
function seedIfEmpty() {
  if (get('SELECT COUNT(*) AS n FROM categories').n) return;
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'demo.json'), 'utf8'));
  tx(() => {
    for (const c of demo.categories) run('INSERT INTO categories (id, name, sequence, icon) VALUES (?, ?, ?, ?)', c.id, c.name, c.sequence, c.icon);
    for (const b of demo.brands) run('INSERT INTO brands (id, name, logo) VALUES (?, ?, ?)', b.id, b.name, b.logo);
    for (const p of demo.products) {
      run(
        `INSERT INTO products (id, sku, name, price, stock, track_stock, brand_id, description, image, featured, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        p.id, 'FS-' + String(p.id).padStart(3, '0'), p.name, p.price, 50, p.brandIds[0] || null, p.description, p.image,
        p.popular ? 1 : 0, p.sequence, p.createDate + ' 10:00:00'
      );
      for (const c of p.categoryIds) run('INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)', p.id, c);
      run("UPDATE products SET origin = '台灣', spec = ?, precautions = ? WHERE id = ?", p.spec || '', DEFAULT_PRECAUTIONS, p.id);
      if (p.sizeChart) run('UPDATE products SET size_chart = ? WHERE id = ?', p.sizeChart, p.id);
    }
  });
  console.log('已建立示範商品資料');
}
seedIfEmpty();

// 分類說明（首頁分類卡片使用，後台可改）；只補空白的
const CATEGORY_DESC = {
  身體護具與支撐: '膝、腰、手腕的日常支撐',
  睡眠與放鬆: '睡前放鬆，找回好眠',
  健康監測與量測: '血壓、體溫在家就能量',
  按摩與舒緩用品: '舒緩痠痛與疲勞',
  居家照護用品: '照顧長輩更安心',
  足部與行動照護: '走得穩、走得舒服',
  個人照護用品: '日常清潔與保養',
};
for (const [name, d] of Object.entries(CATEGORY_DESC)) db.prepare("UPDATE categories SET description = ? WHERE name = ? AND (description IS NULL OR description = '')").run(d, name);

module.exports = { db, all, get, run, tx, hashPassword, checkPassword, settings, saveSettings, DATA_DIR };
