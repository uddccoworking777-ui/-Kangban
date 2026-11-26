// 管理後台 /admin
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { all, get, run, tx, hashPassword, checkPassword, settings, saveSettings } = require('./db');
const { ORDER_STATUS, PAYMENT_STATUS, toProduct, PRODUCT_SQL } = require('./store');
const { PAYMENTS, INVOICES, SHIPPING } = require('./constants');
const google = require('./google');
const geo = require('./geo');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- 圖片上傳 ----------
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + IMG_EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, Boolean(IMG_EXT[file.mimetype])),
});
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const fileUrl = (f) => '/uploads/' + f.filename;

// ---------- 工具 ----------
function log(req, action, detail = '') {
  const a = req.session.admin;
  run('INSERT INTO logs (admin_id, admin_name, action, detail) VALUES (?, ?, ?, ?)', a?.id || null, a?.name || '', action, String(detail).slice(0, 500));
}
function flash(req, type, text) {
  req.session.adminFlash = { type, text };
}
function paginate(req, total, per = 30) {
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
  return { page, pages, per, offset: (page - 1) * per, total };
}
const like = (s) => `%${String(s).replace(/[%_]/g, (m) => '\\' + m)}%`;
const intOrNull = (v) => (v === '' || v == null ? null : Number(v));

router.use((req, res, next) => {
  Object.assign(res.locals, {
    admin: req.session.admin || null,
    adminFlash: req.session.adminFlash || null,
    path: req.path,
    query: req.query,
    ORDER_STATUS,
    PAYMENT_STATUS,
    PAYMENTS,
    INVOICES,
    SHIPPING,
  });
  delete req.session.adminFlash;
  next();
});

// ---------- 首次設定 / 登入 ----------
const hasAdmins = () => get('SELECT COUNT(*) AS n FROM admins').n > 0;

router.get('/setup', (req, res) => {
  if (hasAdmins()) return res.redirect('/admin/login');
  res.render('admin/login', { title: '建立管理員帳號', mode: 'setup', error: null, form: {} });
});
router.post('/setup', (req, res) => {
  if (hasAdmins()) return res.redirect('/admin/login');
  const { name, email, password, confirm } = req.body;
  const error = !name || !email || !password ? '請填寫所有欄位' : password.length < 8 ? '密碼至少 8 個字元' : password !== confirm ? '兩次密碼不一致' : null;
  if (error) return res.status(400).render('admin/login', { title: '建立管理員帳號', mode: 'setup', error, form: req.body });
  const r = run("INSERT INTO admins (name, email, password, role) VALUES (?, ?, ?, 'owner')", name.trim(), email.trim(), hashPassword(password));
  req.session.regenerate(() => {
    req.session.admin = { id: Number(r.lastInsertRowid), name: name.trim(), role: 'owner' };
    log(req, '建立管理員帳號', email);
    res.redirect('/admin');
  });
});

const attempts = new Map();
router.get('/login', (req, res) => {
  if (!hasAdmins()) return res.redirect('/admin/setup');
  res.render('admin/login', { title: '後台登入', mode: 'login', error: null, form: {} });
});
router.post('/login', (req, res) => {
  const key = req.ip + '|' + String(req.body.email || '').toLowerCase();
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) {
    return res.status(429).render('admin/login', { title: '後台登入', mode: 'login', error: '嘗試次數過多，請 10 分鐘後再試', form: req.body });
  }
  const u = get('SELECT * FROM admins WHERE email = ? AND active = 1', String(req.body.email || '').trim());
  if (!u || !checkPassword(req.body.password || '', u.password)) {
    a.n += 1;
    if (a.n >= 5) (a.until = Date.now() + 10 * 60 * 1000), (a.n = 0);
    attempts.set(key, a);
    return res.status(401).render('admin/login', { title: '後台登入', mode: 'login', error: 'Email 或密碼錯誤', form: req.body });
  }
  attempts.delete(key);
  run("UPDATE admins SET last_login = datetime('now','localtime') WHERE id = ?", u.id);
  const keep = { cart: req.session.cart, wishlist: req.session.wishlist, compare: req.session.compare, user: req.session.user };
  req.session.regenerate(() => {
    Object.assign(req.session, keep, { admin: { id: u.id, name: u.name, role: u.role } });
    log(req, '登入後台');
    res.redirect(typeof req.query.next === 'string' && req.query.next.startsWith('/admin') ? req.query.next : '/admin');
  });
});
router.get('/logout', (req, res) => {
  delete req.session.admin;
  res.redirect('/admin/login');
});

// 以下都需要登入
router.use((req, res, next) => {
  const s = req.session.admin;
  const u = s && get('SELECT id, name, role, active FROM admins WHERE id = ?', s.id);
  if (!u || !u.active) {
    delete req.session.admin;
    if (!hasAdmins()) return res.redirect('/admin/setup');
    return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
  }
  req.session.admin = { id: u.id, name: u.name, role: u.role };
  res.locals.admin = req.session.admin;
  res.locals.badge = {
    orders: get("SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','paid')").n,
    messages: get("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'").n,
  };
  next();
});
const ownerOnly = (req, res, next) => (req.session.admin.role === 'owner' ? next() : res.status(403).render('admin/denied', { title: '權限不足' }));

// ---------- 儀表板 ----------
router.get('/', (req, res) => {
  const s = settings();
  const valid = "status != 'cancelled'";
  const sum = (where) => get(`SELECT COALESCE(SUM(total),0) AS v, COUNT(*) AS n FROM orders WHERE ${valid} AND ${where}`);
  const today = sum("date(created_at) = date('now','localtime')");
  const month = sum("strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime')");
  const lastMonth = sum("strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime','start of month','-1 month')");
  const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  const days = all(
    `SELECT date(created_at) AS d, SUM(total) AS v, COUNT(*) AS n FROM orders WHERE ${valid} AND date(created_at) >= date('now','localtime','-${range - 1} days') GROUP BY d`
  );
  const byDay = Object.fromEntries(days.map((r) => [r.d, r]));
  const series = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    series.push({ d: key, v: byDay[key]?.v || 0, n: byDay[key]?.n || 0 });
  }
  const threshold = Number(s.low_stock_threshold || 0);
  const todo = {
    awaitingPayment: get("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending' AND payment_status = 'unpaid' AND payment_method != 'cod'").n,
    toShip: get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' OR (status = 'pending' AND payment_method = 'cod')").n,
    messages: get("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'").n,
    lowStock: get('SELECT COUNT(*) AS n FROM products WHERE track_stock = 1 AND published = 1 AND stock <= ?', threshold).n,
  };
  const rangeTotal = series.reduce((a, d) => a + d.v, 0);
  const rangeCount = series.reduce((a, d) => a + d.n, 0);
  res.render('admin/dashboard', {
    title: '總覽',
    range,
    rangeTotal,
    rangeCount,
    todo,
    today,
    month,
    lastMonth,
    series,
    pendingOrders: get("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").n,
    toShip: get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").n,
    newMessages: get("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'").n,
    customers: get('SELECT COUNT(*) AS n FROM customers').n,
    lowStock: all('SELECT id, name, stock FROM products WHERE track_stock = 1 AND published = 1 AND stock <= ? ORDER BY stock LIMIT 8', Number(s.low_stock_threshold || 0)),
    recent: all('SELECT id, name, customer_name, total, status, payment_status, created_at FROM orders ORDER BY id DESC LIMIT 8'),
    top: all(
      `SELECT i.name, SUM(i.qty) AS qty, SUM(i.subtotal) AS amount FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.${valid} AND date(o.created_at) >= date('now','localtime','-${range - 1} days') GROUP BY i.product_id, i.name ORDER BY qty DESC LIMIT 5`
    ),
  });
});

// ---------- 全站搜尋 ----------
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.redirect('/admin');
  const L = like(q);
  const orders = all("SELECT id, name, customer_name, total, status, created_at FROM orders WHERE name LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR tracking_number LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 20", L, L, L, L, L);
  const products = all("SELECT id, name, sku, price, stock, track_stock FROM products WHERE name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 20", L, L);
  const customers = all("SELECT id, name, email, phone FROM customers WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 20", L, L, L);
  const total = orders.length + products.length + customers.length;
  if (total === 1) {
    if (orders[0]) return res.redirect('/admin/orders/' + orders[0].id);
    if (products[0]) return res.redirect('/admin/products/' + products[0].id);
    return res.redirect('/admin/customers/' + customers[0].id);
  }
  res.render('admin/search', { title: '搜尋結果', q, orders, products, customers });
});

// ---------- 訂單 ----------
function orderFilter(q) {
  const where = [];
  const params = [];
  if (q.todo === 'ship') where.push("(status = 'paid' OR (status = 'pending' AND payment_method = 'cod'))");
  else if (q.todo === 'payment') where.push("status = 'pending' AND payment_status = 'unpaid' AND payment_method != 'cod'");
  else if (q.status) where.push('status = ?'), params.push(q.status);
  if (q.payment) where.push('payment_status = ?'), params.push(q.payment);
  if (q.from) where.push('date(created_at) >= ?'), params.push(q.from);
  if (q.to) where.push('date(created_at) <= ?'), params.push(q.to);
  if (q.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')");
    params.push(like(q.q), like(q.q), like(q.q), like(q.q));
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
router.get('/orders', (req, res) => {
  const f = orderFilter(req.query);
  const pg = paginate(req, get(`SELECT COUNT(*) AS n FROM orders ${f.sql}`, ...f.params).n);
  const orders = all(`SELECT o.*, (SELECT SUM(qty) FROM order_items i WHERE i.order_id = o.id) AS item_count FROM orders o ${f.sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...f.params, pg.per, pg.offset);
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').map((r) => [r.status, r.n]));
  res.render('admin/orders', { title: '訂單', orders, pg, counts });
});
router.get('/orders.csv', (req, res) => {
  const f = orderFilter(req.query);
  const rows = all(`SELECT * FROM orders ${f.sql} ORDER BY id DESC`, ...f.params);
  const items = all(`SELECT order_id, name, qty FROM order_items WHERE order_id IN (SELECT id FROM orders ${f.sql})`, ...f.params);
  const byOrder = {};
  for (const i of items) (byOrder[i.order_id] ||= []).push(`${i.name}×${i.qty}`);
  const data = [
    ['訂單編號', '日期', '狀態', '付款狀態', '客戶', 'Email', '電話', '配送', '地址／門市', '付款方式', '發票', '統編', '商品', '小計', '運費', '總計', '物流單號', '備註'],
    ...rows.map((o) => [
      o.name, o.created_at, ORDER_STATUS[o.status], PAYMENT_STATUS[o.payment_status], o.customer_name, o.email, o.phone,
      SHIPPING[o.shipping_method] || o.shipping_method, o.cvs_store || `${o.zip} ${o.city}${o.street}`, PAYMENTS[o.payment_method] || o.payment_method,
      INVOICES[o.invoice_type] || '', o.vat, (byOrder[o.id] || []).join('、'), o.subtotal, o.shipping_fee, o.total, o.tracking_number, o.note,
    ]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(google.toCsv(data));
});
router.get('/orders/:id', (req, res, next) => {
  const o = get('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
  if (!o) return next();
  o.items = all('SELECT * FROM order_items WHERE order_id = ?', o.id);
  const history = all("SELECT * FROM logs WHERE detail LIKE ? ORDER BY id DESC LIMIT 20", o.name + '%');
  res.render('admin/order', { title: '訂單 ' + o.name, o, history });
});
// 變更訂單狀態（處理庫存、時間戳記、操作紀錄）
function changeOrder(req, o, { status = o.status, payment = o.payment_status, tracking, adminNote }) {
  const changes = [];
  tx(() => {
    if (status === 'cancelled' && o.status !== 'cancelled') {
      for (const i of all('SELECT product_id, qty FROM order_items WHERE order_id = ?', o.id)) run('UPDATE products SET stock = stock + CASE WHEN track_stock = 1 THEN ? ELSE 0 END, sold_count = MAX(0, sold_count - ?) WHERE id = ?', i.qty, i.qty, i.product_id);
    } else if (o.status === 'cancelled' && status !== 'cancelled') {
      for (const i of all('SELECT product_id, qty FROM order_items WHERE order_id = ?', o.id)) run('UPDATE products SET stock = stock - CASE WHEN track_stock = 1 THEN ? ELSE 0 END, sold_count = sold_count + ? WHERE id = ?', i.qty, i.qty, i.product_id);
    }
    run(
      `UPDATE orders SET status = ?, payment_status = ?, tracking_number = ?, admin_note = ?,
        paid_at = CASE WHEN ? = 'paid' AND paid_at IS NULL THEN datetime('now','localtime') ELSE paid_at END,
        shipped_at = CASE WHEN ? IN ('shipped','completed') AND shipped_at IS NULL THEN datetime('now','localtime') ELSE shipped_at END,
        updated_at = datetime('now','localtime') WHERE id = ?`,
      status, payment, tracking ?? o.tracking_number, adminNote ?? o.admin_note, payment, status, o.id
    );
  });
  if (status !== o.status) changes.push(`狀態：${ORDER_STATUS[o.status]} → ${ORDER_STATUS[status]}`);
  if (payment !== o.payment_status) changes.push(`付款：${PAYMENT_STATUS[o.payment_status]} → ${PAYMENT_STATUS[payment]}`);
  if (tracking != null && (tracking || '') !== (o.tracking_number || '')) changes.push(`物流單號：${tracking}`);
  if (changes.length) log(req, '更新訂單', `${o.name} ${changes.join('；')}`);
  return changes;
}

const ACTIONS = {
  confirm_payment: (o) => ({ payment: 'paid', status: o.status === 'pending' ? 'paid' : o.status }),
  ship: (o, b) => ({ status: 'shipped', tracking: b.tracking_number ?? o.tracking_number }),
  complete: (o) => ({ status: 'completed', payment: o.payment_method === 'cod' ? 'paid' : o.payment_status }),
  cancel: () => ({ status: 'cancelled' }),
};
router.post('/orders/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (req.body.action === 'print') return res.redirect('/admin/orders/print?ids=' + ids.join(','));
  const fn = ACTIONS[req.body.action];
  let n = 0;
  if (fn) {
    for (const id of ids) {
      const o = get('SELECT * FROM orders WHERE id = ?', id);
      if (o && o.status !== 'cancelled' && changeOrder(req, o, fn(o, {})).length) n++;
    }
  }
  flash(req, 'success', `已更新 ${n} 筆訂單`);
  res.redirect('/admin/orders' + (req.body.back || ''));
});
router.get('/orders/print', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 100);
  const orders = ids.map((id) => {
    const o = get('SELECT * FROM orders WHERE id = ?', id);
    if (o) o.items = all('SELECT * FROM order_items WHERE order_id = ?', o.id);
    return o;
  }).filter(Boolean);
  res.render('admin/print', { title: '出貨單', orders });
});
router.post('/orders/:id/action', (req, res, next) => {
  const o = get('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
  const fn = ACTIONS[req.body.action];
  if (!o || !fn) return next();
  if (req.body.action === 'ship' && !String(req.body.tracking_number || '').trim() && !o.tracking_number) {
    flash(req, 'error', '請先填寫物流單號再出貨');
    return res.redirect('/admin/orders/' + o.id);
  }
  changeOrder(req, o, fn(o, req.body));
  flash(req, 'success', { confirm_payment: '已確認收款', ship: '已標記出貨', complete: '訂單已完成', cancel: '訂單已取消，庫存已加回' }[req.body.action]);
  res.redirect('/admin/orders/' + o.id);
});
router.post('/orders/:id', (req, res, next) => {
  const o = get('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
  if (!o) return next();
  const status = ORDER_STATUS[req.body.status] ? req.body.status : o.status;
  const payment = PAYMENT_STATUS[req.body.payment_status] ? req.body.payment_status : o.payment_status;
  changeOrder(req, o, { status, payment, tracking: req.body.tracking_number, adminNote: req.body.admin_note });
  flash(req, 'success', '訂單已更新');
  res.redirect('/admin/orders/' + o.id);
});
// ---------- 商品 ----------
router.get('/products', (req, res) => {
  const where = [];
  const p = [];
  const q = req.query;
  if (q.q) where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')"), p.push(like(q.q), like(q.q));
  if (q.category) where.push('EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)'), p.push(Number(q.category));
  if (q.status === 'published') where.push('p.published = 1');
  if (q.status === 'draft') where.push('p.published = 0');
  if (q.status === 'out') where.push('p.track_stock = 1 AND p.stock <= 0');
  if (q.status === 'low') where.push('p.track_stock = 1 AND p.stock <= ?'), p.push(Number(settings().low_stock_threshold || 0));
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pg = paginate(req, get(`SELECT COUNT(*) AS n FROM products p ${w}`, ...p).n, 50);
  const SORT = { name: 'p.name', price: 'p.price', stock: 'p.stock', sold: 'p.sold_count', updated: 'p.updated_at' };
  const sortCol = SORT[q.sort] || 'p.sequence';
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const products = all(`${PRODUCT_SQL} ${w} ORDER BY ${sortCol} ${dir}, p.id LIMIT ? OFFSET ?`, ...p, pg.per, pg.offset).map((r) => ({ ...toProduct(r), published: Boolean(r.published) }));
  res.render('admin/products', { title: '商品', products, pg, cats: all('SELECT id, name FROM categories ORDER BY sequence, id') });
});
router.post('/products/:id/stock', (req, res) => {
  const id = Number(req.params.id);
  const stock = Math.floor(Number(req.body.stock));
  const p = get('SELECT name, stock FROM products WHERE id = ?', id);
  if (!p || !Number.isFinite(stock)) return res.status(400).json({ error: '數量不正確' });
  run("UPDATE products SET stock = ?, track_stock = 1, updated_at = datetime('now','localtime') WHERE id = ?", stock, id);
  log(req, '調整庫存', `${p.name}：${p.stock} → ${stock}`);
  res.json({ ok: true, stock });
});
router.post('/products/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const act = req.body.action;
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    if (act === 'publish') run(`UPDATE products SET published = 1 WHERE id IN (${ph})`, ...ids);
    if (act === 'unpublish') run(`UPDATE products SET published = 0 WHERE id IN (${ph})`, ...ids);
    if (act === 'delete') run(`DELETE FROM products WHERE id IN (${ph})`, ...ids);
    log(req, { publish: '批次上架', unpublish: '批次下架', delete: '批次刪除商品' }[act] || act, `${ids.length} 項商品`);
    flash(req, 'success', `已處理 ${ids.length} 項商品`);
  }
  res.redirect('/admin/products' + (req.body.back || ''));
});
function productForm(res, p, errors = {}) {
  res.render('admin/product-form', {
    title: p.id ? '編輯商品' : '新增商品',
    p,
    errors,
    cats: all('SELECT id, name, parent_id FROM categories ORDER BY sequence, id'),
    brands: all('SELECT id, name FROM brands ORDER BY sequence, id'),
  });
}
const blankProduct = () => ({ meta_description: '', summary: '', faq: '', id: null, name: '', sku: '', price: '', compare_price: '', cost: '', stock: 0, track_stock: 1, brand_id: null, description: '', description_html: '', license_no: '', is_medical: 0, license_holder: '', manufacturer: '', origin: '', spec: '', size_chart: '', precautions: '使用前請詳閱說明書及注意事項。\n如有身體不適，請諮詢醫師或藥師。', images: [], published: 1, featured: 0, sequence: 0, categoryIds: [] });
router.get('/products/new', (req, res) => productForm(res, blankProduct()));
router.get('/products/:id', (req, res, next) => {
  const r = get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
  if (!r) return next();
  const images = JSON.parse(r.images || '[]');
  if (r.image && !images.includes(r.image)) images.unshift(r.image);
  const categoryIds = all('SELECT category_id FROM product_categories WHERE product_id = ?', r.id).map((x) => x.category_id);
  const sales = get("SELECT COALESCE(SUM(qty),0) AS qty FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = ? AND o.status != 'cancelled'", r.id).qty;
  productForm(res, { ...r, images, categoryIds, sales, faq: geo.faqToText(geo.parseFaq(r.faq)) });
});
router.post(['/products/new', '/products/:id'], upload.array('image_files', 12), (req, res, next) => {
  const id = req.params.id ? Number(req.params.id) : null;
  if (id && !get('SELECT id FROM products WHERE id = ?', id)) return next();
  const b = req.body;
  const kept = [].concat(b.images || []).filter((u) => !([].concat(b.remove_images || [])).includes(u));
  const urls = String(b.image_urls || '').split(/\s+/).filter((u) => /^(https?:\/\/|\/)/.test(u)).map(google.normalizeImageUrl);
  const images = [...kept, ...urls, ...(req.files || []).map(fileUrl)];
  if (b.main_image && images.includes(b.main_image)) images.unshift(...images.splice(images.indexOf(b.main_image), 1));
  const v = {
    name: String(b.name || '').trim(),
    sku: String(b.sku || '').trim() || null,
    price: Number(b.price),
    compare_price: intOrNull(b.compare_price),
    cost: intOrNull(b.cost),
    stock: Math.floor(Number(b.stock) || 0),
    track_stock: b.track_stock ? 1 : 0,
    brand_id: intOrNull(b.brand_id),
    description: b.description || '',
    description_html: b.description_html || '',
    license_no: b.license_no || '',
    is_medical: b.is_medical ? 1 : 0,
    license_holder: b.license_holder || '',
    manufacturer: b.manufacturer || '',
    origin: b.origin || '',
    spec: b.spec || '',
    size_chart: b.size_chart || '',
    precautions: b.precautions || '',
    meta_description: String(b.meta_description || '').trim().slice(0, 300),
    summary: String(b.summary || '').trim(),
    faq: JSON.stringify(geo.faqFromText(b.faq)),
    image: images[0] || null,
    images: JSON.stringify(images),
    published: b.published ? 1 : 0,
    featured: b.featured ? 1 : 0,
    sequence: Number(b.sequence) || 0,
  };
  const categoryIds = [].concat(b.categories || []).map(Number).filter(Boolean);
  const errors = {};
  if (!v.name) errors.name = '請填寫商品名稱';
  if (!Number.isFinite(v.price) || v.price < 0) errors.price = '請填寫正確的價格';
  if (v.sku && get('SELECT id FROM products WHERE sku = ? AND id IS NOT ?', v.sku, id)) errors.sku = '這個貨號已被其他商品使用';
  if (v.is_medical && !v.license_no) errors.license_no = '醫療器材必須填寫許可證字號（依法須在商品頁揭露）';
  if (Object.keys(errors).length) return productForm(res.status(400), { ...v, faq: b.faq || '', id, images, categoryIds }, errors);
  let pid = id;
  tx(() => {
    const cols = Object.keys(v);
    if (id) run(`UPDATE products SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`, ...Object.values(v), id);
    else pid = Number(run(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(v)).lastInsertRowid);
    run('DELETE FROM product_categories WHERE product_id = ?', pid);
    for (const c of categoryIds) run('INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)', pid, c);
  });
  geo.autoFillProduct(pid); // 開啟「自動優化」時，補齊空白的搜尋描述、重點摘要、常見問答
  log(req, id ? '編輯商品' : '新增商品', v.name);
  flash(req, 'success', id ? '商品已儲存' : '商品已新增');
  res.redirect(b.save_and_new ? '/admin/products/new' : '/admin/products/' + pid);
});
router.post('/products/:id/delete', (req, res) => {
  const p = get('SELECT name FROM products WHERE id = ?', Number(req.params.id));
  if (p) run('DELETE FROM products WHERE id = ?', Number(req.params.id)), log(req, '刪除商品', p.name);
  flash(req, 'success', '商品已刪除');
  res.redirect('/admin/products');
});
router.post('/products/:id/duplicate', (req, res, next) => {
  const r = get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
  if (!r) return next();
  const nid = tx(() => {
    const n = Number(
      run(
        `INSERT INTO products (name, price, compare_price, cost, stock, track_stock, brand_id, description, description_html, license_no, image, images, published, featured, sequence,
           is_medical, license_holder, manufacturer, origin, spec, size_chart, precautions)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.name + '（複製）', r.price, r.compare_price, r.cost, r.track_stock, r.brand_id, r.description, r.description_html, r.license_no, r.image, r.images, r.featured, r.sequence,
        r.is_medical, r.license_holder, r.manufacturer, r.origin, r.spec, r.size_chart, r.precautions
      ).lastInsertRowid
    );
    run('INSERT INTO product_categories (product_id, category_id) SELECT ?, category_id FROM product_categories WHERE product_id = ?', n, r.id);
    return n;
  });
  log(req, '複製商品', r.name);
  flash(req, 'success', '已複製商品（預設為下架，請修改後再上架）');
  res.redirect('/admin/products/' + nid);
});
router.get('/products.csv', (req, res) => {
  const rows = all(`${PRODUCT_SQL} ORDER BY p.sequence, p.id`).map(toProduct);
  const cats = Object.fromEntries(all('SELECT id, name FROM categories').map((c) => [c.id, c.name]));
  const brands = Object.fromEntries(all('SELECT id, name FROM brands').map((c) => [c.id, c.name]));
  const raw = Object.fromEntries(all('SELECT id, compare_price, published, license_holder, manufacturer, origin, spec, precautions FROM products').map((r) => [r.id, r]));
  const data = [
    google.TEMPLATE_HEADER,
    ...rows.map((p) => [
      p.sku, p.name, p.price, raw[p.id].compare_price ?? '', p.trackStock ? p.stock : '', p.categoryIds.map((c) => cats[c]).join('、'),
      brands[p.brandIds[0]] || '', p.description, [p.image, ...p.images].filter((u) => u && !u.endsWith('logo.webp')).map((u) => (u.startsWith('/') ? `${req.protocol}://${req.get('host')}${u}` : u)).join('\n'),
      p.licenseNo, raw[p.id].published ? '是' : '否', p.popular ? '是' : '否', p.sequence,
      raw[p.id].license_holder || '', raw[p.id].manufacturer || '', raw[p.id].origin || '', raw[p.id].spec || '', raw[p.id].precautions || '',
    ]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(google.toCsv(data));
});

// ---------- 分類 / 品牌（共用寫法） ----------
router.get('/categories', (req, res) => {
  const rows = all('SELECT c.*, (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id = c.id) AS count FROM categories c ORDER BY sequence, id');
  res.render('admin/categories', { title: '商品分類', rows, edit: rows.find((r) => r.id === Number(req.query.edit)) || null });
});
router.post('/categories', upload.single('icon_file'), (req, res) => {
  const b = req.body;
  const id = Number(b.id) || null;
  const name = String(b.name || '').trim();
  if (!name) return flash(req, 'error', '請填寫分類名稱'), res.redirect('/admin/categories');
  if (get('SELECT id FROM categories WHERE name = ? AND id IS NOT ?', name, id)) return flash(req, 'error', '已有相同名稱的分類'), res.redirect('/admin/categories');
  const icon = req.file ? fileUrl(req.file) : b.icon || null;
  const parent = intOrNull(b.parent_id);
  const vals = [name, parent === id ? null : parent, Number(b.sequence) || 0, icon, b.description || '', b.published ? 1 : 0, String(b.seo_intro || '').trim()];
  if (id) run('UPDATE categories SET name = ?, parent_id = ?, sequence = ?, icon = ?, description = ?, published = ?, seo_intro = ? WHERE id = ?', ...vals, id);
  else run('INSERT INTO categories (name, parent_id, sequence, icon, description, published, seo_intro) VALUES (?, ?, ?, ?, ?, ?, ?)', ...vals);
  log(req, id ? '編輯分類' : '新增分類', name);
  flash(req, 'success', '分類已儲存');
  res.redirect('/admin/categories');
});
router.post('/categories/:id/delete', (req, res) => {
  const c = get('SELECT name FROM categories WHERE id = ?', Number(req.params.id));
  if (c) run('DELETE FROM categories WHERE id = ?', Number(req.params.id)), log(req, '刪除分類', c.name);
  flash(req, 'success', '分類已刪除（商品不會被刪除）');
  res.redirect('/admin/categories');
});
router.get('/brands', (req, res) => {
  const rows = all('SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS count FROM brands b ORDER BY sequence, id');
  res.render('admin/brands', { title: '品牌', rows, edit: rows.find((r) => r.id === Number(req.query.edit)) || null });
});
router.post('/brands', upload.single('logo_file'), (req, res) => {
  const b = req.body;
  const id = Number(b.id) || null;
  const name = String(b.name || '').trim();
  if (!name) return flash(req, 'error', '請填寫品牌名稱'), res.redirect('/admin/brands');
  if (get('SELECT id FROM brands WHERE name = ? AND id IS NOT ?', name, id)) return flash(req, 'error', '已有相同名稱的品牌'), res.redirect('/admin/brands');
  const logo = req.file ? fileUrl(req.file) : b.logo || null;
  if (id) run('UPDATE brands SET name = ?, logo = ?, sequence = ? WHERE id = ?', name, logo, Number(b.sequence) || 0, id);
  else run('INSERT INTO brands (name, logo, sequence) VALUES (?, ?, ?)', name, logo, Number(b.sequence) || 0);
  log(req, id ? '編輯品牌' : '新增品牌', name);
  flash(req, 'success', '品牌已儲存');
  res.redirect('/admin/brands');
});
router.post('/brands/:id/delete', (req, res) => {
  const c = get('SELECT name FROM brands WHERE id = ?', Number(req.params.id));
  if (c) run('DELETE FROM brands WHERE id = ?', Number(req.params.id)), log(req, '刪除品牌', c.name);
  flash(req, 'success', '品牌已刪除');
  res.redirect('/admin/brands');
});

// ---------- 客戶 ----------
router.get('/customers', (req, res) => {
  const w = req.query.q ? "WHERE c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\'" : '';
  const p = req.query.q ? [like(req.query.q), like(req.query.q), like(req.query.q)] : [];
  const pg = paginate(req, get(`SELECT COUNT(*) AS n FROM customers c ${w}`, ...p).n);
  const rows = all(
    `SELECT c.*, (c.password IS NOT NULL) AS member,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS orders,
      (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS spent,
      (SELECT MAX(created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order
     FROM customers c ${w} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    ...p, pg.per, pg.offset
  );
  res.render('admin/customers', { title: '顧客', rows, pg });
});
router.get('/customers.csv', (req, res) => {
  const rows = all(`SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS orders,
    (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS spent FROM customers c ORDER BY c.id`);
  const data = [['姓名', 'Email', '電話', '地址', '會員', '訂單數', '累計消費', '建立日期'], ...rows.map((c) => [c.name, c.email, c.phone, `${c.zip || ''} ${c.city || ''}${c.street || ''}`, c.password ? '是' : '否', c.orders, c.spent, c.created_at])];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
  res.send(google.toCsv(data));
});
router.get('/customers/:id', (req, res, next) => {
  const c = get('SELECT * FROM customers WHERE id = ?', Number(req.params.id));
  if (!c) return next();
  const orders = all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', c.id);
  res.render('admin/customer', { title: c.name, c, orders });
});
router.post('/customers/:id', (req, res) => {
  const b = req.body;
  run('UPDATE customers SET name = ?, phone = ?, zip = ?, city = ?, street = ?, note = ? WHERE id = ?', b.name, b.phone, b.zip, b.city, b.street, b.note, Number(req.params.id));
  if (b.new_password) {
    if (b.new_password.length < 8) return flash(req, 'error', '密碼至少 8 個字元'), res.redirect('/admin/customers/' + req.params.id);
    run('UPDATE customers SET password = ? WHERE id = ?', hashPassword(b.new_password), Number(req.params.id));
    log(req, '重設客戶密碼', b.name);
  }
  log(req, '編輯客戶', b.name);
  flash(req, 'success', '客戶資料已儲存');
  res.redirect('/admin/customers/' + req.params.id);
});

// ---------- 客服訊息 ----------
router.get('/messages', (req, res) => {
  const status = req.query.status === 'done' ? 'done' : req.query.status === 'all' ? null : 'new';
  const rows = all(`SELECT * FROM messages ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 200`, ...(status ? [status] : []));
  res.render('admin/messages', { title: '客服訊息', rows, status: status || 'all' });
});
router.post('/messages/:id', (req, res) => {
  const status = req.body.status === 'done' ? 'done' : 'new';
  run('UPDATE messages SET status = ?, reply_note = COALESCE(?, reply_note) WHERE id = ?', status, req.body.reply_note ?? null, Number(req.params.id));
  log(req, status === 'done' ? '客服訊息已處理' : '客服訊息標為未處理', '#' + req.params.id);
  res.redirect(req.get('referer') || '/admin/messages');
});

// ---------- 匯入（Google 試算表 / CSV） ----------
const previews = new Map(); // token -> { items, source, at }
function planImport(items) {
  return items.map((it) => {
    if (it.errors.length) return { ...it, action: 'error' };
    const ex = (it.sku && get('SELECT id FROM products WHERE sku = ?', it.sku)) || get('SELECT id FROM products WHERE name = ? AND (sku IS NULL OR sku = ?)', it.name, it.sku || '');
    return { ...it, action: ex ? 'update' : 'create', existingId: ex?.id || null };
  });
}
function renderImport(res, extra = {}) {
  const s = settings();
  res.render('admin/import', {
    title: '匯入／匯出',
    plan: null,
    token: null,
    error: null,
    result: null,
    googleReady: Boolean(s.google_api_key || s.google_service_account),
    serviceEmail: (() => {
      try {
        return JSON.parse(s.google_service_account || '{}').client_email || '';
      } catch {
        return '';
      }
    })(),
    header: google.TEMPLATE_HEADER,
    ...extra,
  });
}
router.get('/import', (req, res) => renderImport(res));
router.get('/import/template.csv', (req, res) => {
  const data = [
    google.TEMPLATE_HEADER,
    ['FS-001', '量子訊息多那之護膝', '2800', '3200', '50', '身體護具與支撐', '愛放鬆 fun song', '商品簡介…', 'https://example.com/a.jpg', '衛部醫器製壹字第000000號', '是', '是', '1'],
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="product-template.csv"');
  res.send(google.toCsv(data));
});
function storePreview(req, res, items, source) {
  const plan = planImport(items);
  const token = crypto.randomBytes(12).toString('hex');
  previews.set(token, { plan, source, at: Date.now(), admin: req.session.admin.id });
  for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60 * 1000) previews.delete(k);
  renderImport(res, { plan, token, source });
}
router.post(
  '/import/google',
  ah(async (req, res) => {
    const s = settings();
    const sheetUrl = req.body.sheet_url || s.google_sheet_url;
    const range = req.body.range ?? s.google_sheet_range;
    saveSettings({ google_sheet_url: sheetUrl, google_sheet_range: range || '' });
    try {
      const rows = await google.fetchSheet({ sheetUrl, range, apiKey: s.google_api_key, serviceAccount: s.google_service_account || null });
      storePreview(req, res, google.rowsToProducts(rows), 'Google 試算表');
    } catch (e) {
      renderImport(res.status(400), { error: e.message });
    }
  })
);
router.post('/import/csv', csvUpload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('請選擇 CSV 檔案');
    storePreview(req, res, google.rowsToProducts(google.parseCsv(req.file.buffer.toString('utf8'))), 'CSV 檔案');
  } catch (e) {
    renderImport(res.status(400), { error: e.message });
  }
});
router.post('/import/confirm', (req, res) => {
  const pv = previews.get(req.body.token);
  if (!pv || pv.admin !== req.session.admin.id) return renderImport(res.status(400), { error: '預覽已過期，請重新讀取試算表' });
  previews.delete(req.body.token);
  const unpublishMissing = Boolean(req.body.unpublish_missing);
  const result = { created: 0, updated: 0, skipped: 0, unpublished: 0, newCats: [], newBrands: [] };
  tx(() => {
    const catId = (name) => {
      const c = get('SELECT id FROM categories WHERE name = ?', name);
      if (c) return c.id;
      result.newCats.push(name);
      return Number(run('INSERT INTO categories (name, sequence) VALUES (?, 99)', name).lastInsertRowid);
    };
    const brandId = (name) => {
      const b = get('SELECT id FROM brands WHERE name = ?', name);
      if (b) return b.id;
      result.newBrands.push(name);
      return Number(run('INSERT INTO brands (name) VALUES (?)', name).lastInsertRowid);
    };
    const touched = new Set();
    for (const it of pv.plan) {
      if (it.action === 'error') {
        result.skipped++;
        continue;
      }
      const v = { name: it.name, price: it.price, published: it.published };
      if (it.sku) v.sku = it.sku;
      if (it.compare_price !== undefined) v.compare_price = it.compare_price;
      if (it.cost !== undefined && !Number.isNaN(it.cost)) v.cost = it.cost;
      if (it.stock !== undefined) (v.stock = it.stock), (v.track_stock = 1);
      if (it.brand !== undefined) v.brand_id = it.brand ? brandId(it.brand) : null;
      if (it.description !== undefined) v.description = it.description;
      if (it.license_no !== undefined) (v.license_no = it.license_no), (v.is_medical = it.license_no ? 1 : 0);
      for (const f of ['license_holder', 'manufacturer', 'origin', 'spec', 'precautions']) if (it[f] !== undefined) v[f] = it[f];
      if (it.featured !== undefined) v.featured = it.featured;
      if (it.sequence !== undefined) v.sequence = it.sequence;
      if (it.images !== undefined) (v.images = JSON.stringify(it.images)), (v.image = it.images[0] || null);
      const cols = Object.keys(v);
      let pid = it.existingId;
      const existing = pid ? get('SELECT id FROM products WHERE id = ?', pid) : null;
      if (existing) {
        run(`UPDATE products SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`, ...Object.values(v), pid);
        result.updated++;
      } else {
        pid = Number(run(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(v)).lastInsertRowid);
        result.created++;
      }
      touched.add(pid);
      if (it.categories !== undefined) {
        run('DELETE FROM product_categories WHERE product_id = ?', pid);
        for (const name of it.categories) run('INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)', pid, catId(name));
      }
    }
    if (unpublishMissing && touched.size) {
      const ids = [...touched];
      result.unpublished = Number(run(`UPDATE products SET published = 0 WHERE published = 1 AND id NOT IN (${ids.map(() => '?').join(',')})`, ...ids).changes);
    }
  });
  log(req, '匯入商品', `${pv.source}：新增 ${result.created}、更新 ${result.updated}、略過 ${result.skipped}${result.unpublished ? `、下架 ${result.unpublished}` : ''}`);
  renderImport(res, { result });
});

// ---------- 設定 ----------
const SETTING_GROUPS = [
  ['商店資訊', [
    ['store_name', '商店名稱'], ['company_name', '公司全名'], ['founded_year', '成立年份'], ['tax_id', '統一編號'],
    ['license_no', '醫療器材販賣業藥商許可執照字號'], ['address', '公司地址'], ['phone', '客服電話'], ['email', '客服信箱'],
    ['service_hours', '客服時間'], ['reply_days', '客服回覆天數（工作天）'], ['partner_brands_text', '關於我們頁的合作品牌文字'],
  ]],
  ['網站公告', [['announcement', '頁面最上方公告列文字（留空 = 不顯示）'], ['hot_keywords', '熱門搜尋關鍵字（逗號分隔，顯示在搜尋框下方）'], ['fda_lookup_url', '食藥署許可證查詢網址']]],
  ['社群連結', [['line_id', 'LINE 官方帳號 ID'], ['line_url', 'LINE 加好友網址'], ['facebook_url', 'Facebook 網址'], ['instagram_url', 'Instagram 網址']]],
  ['運費與出貨', [
    ['shipping_home', '宅配運費（元）', 'number'], ['shipping_cvs', '超商取貨運費（元）', 'number'], ['free_shipping_threshold', '免運門檻（元）', 'number'],
    ['ship_days', '付款後出貨天數（例：1–3）'], ['delivery_days', '宅配到貨天數（例：1–2）'], ['low_stock_threshold', '低庫存提醒數量', 'number'],
  ]],
  ['付款與退款', [['bank_info', 'ATM 匯款資訊（顯示在訂單完成頁）', 'textarea'], ['payment_deadline_days', 'ATM 付款期限（天）', 'number'], ['refund_days', '退款處理天數（工作天）', 'number']]],
  ['Google 匯入', [
    ['google_api_key', 'Google API 金鑰（公開試算表用）', 'password'],
    ['google_service_account', '服務帳戶金鑰 JSON（私人試算表用，貼上 .json 檔全部內容）', 'secret'],
    ['google_sheet_url', '預設試算表網址'], ['google_sheet_range', '預設範圍（選填，例：商品!A1:M）'],
  ]],
];
router.get('/settings', ownerOnly, (req, res) => res.render('admin/settings', { title: '商店設定', groups: SETTING_GROUPS, s: settings() }));
router.post('/settings', ownerOnly, (req, res) => {
  const vals = {};
  for (const [, fields] of SETTING_GROUPS) {
    for (const [key, , type] of fields) {
      if (!(key in req.body)) continue;
      if ((type === 'secret' || type === 'password') && req.body[key] === '__KEEP__') continue;
      vals[key] = req.body[key];
    }
  }
  if (vals.google_service_account) {
    try {
      const j = JSON.parse(vals.google_service_account);
      if (!j.client_email || !j.private_key) throw new Error();
    } catch {
      flash(req, 'error', '服務帳戶金鑰格式不正確：請貼上從 Google Cloud 下載的 .json 檔完整內容');
      return res.redirect('/admin/settings#google');
    }
  }
  saveSettings(vals);
  log(req, '更新設定', Object.keys(vals).filter((k) => !k.startsWith('google_api') && k !== 'google_service_account').join(', '));
  flash(req, 'success', '設定已儲存');
  res.redirect('/admin/settings');
});
router.post(
  '/settings/test-google',
  ownerOnly,
  ah(async (req, res) => {
    const s = settings();
    try {
      const rows = await google.fetchSheet({ sheetUrl: s.google_sheet_url, range: s.google_sheet_range, apiKey: s.google_api_key, serviceAccount: s.google_service_account || null });
      flash(req, 'success', `連線成功！讀到 ${rows.length} 列（含標題列）`);
    } catch (e) {
      flash(req, 'error', e.message);
    }
    res.redirect('/admin/settings#google');
  })
);

// ---------- 管理員 ----------
router.get('/admins', ownerOnly, (req, res) => res.render('admin/admins', { title: '帳號與權限', rows: all('SELECT id, name, email, role, active, last_login, created_at FROM admins ORDER BY id') }));
router.post('/admins', ownerOnly, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8) return flash(req, 'error', '請填寫姓名、Email，密碼至少 8 個字元'), res.redirect('/admin/admins');
  if (get('SELECT id FROM admins WHERE email = ?', email.trim())) return flash(req, 'error', '這個 Email 已經是管理員'), res.redirect('/admin/admins');
  run('INSERT INTO admins (name, email, password, role) VALUES (?, ?, ?, ?)', name.trim(), email.trim(), hashPassword(password), role === 'owner' ? 'owner' : 'staff');
  log(req, '新增管理員', email);
  flash(req, 'success', '已新增管理員');
  res.redirect('/admin/admins');
});
router.post('/admins/:id', ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const target = get('SELECT * FROM admins WHERE id = ?', id);
  if (!target) return res.redirect('/admin/admins');
  const owners = get("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND active = 1").n;
  if (req.body.action === 'toggle') {
    if (id === req.session.admin.id) return flash(req, 'error', '不能停用自己的帳號'), res.redirect('/admin/admins');
    if (target.role === 'owner' && target.active && owners <= 1) return flash(req, 'error', '至少要保留一位啟用中的擁有者'), res.redirect('/admin/admins');
    run('UPDATE admins SET active = 1 - active WHERE id = ?', id);
    log(req, target.active ? '停用管理員' : '啟用管理員', target.email);
  } else if (req.body.action === 'role') {
    const role = req.body.role === 'owner' ? 'owner' : 'staff';
    if (target.role === 'owner' && role === 'staff' && owners <= 1) return flash(req, 'error', '至少要保留一位擁有者'), res.redirect('/admin/admins');
    run('UPDATE admins SET role = ? WHERE id = ?', role, id);
    log(req, '變更管理員權限', `${target.email} → ${role}`);
  } else if (req.body.action === 'password' && req.body.password?.length >= 8) {
    run('UPDATE admins SET password = ? WHERE id = ?', hashPassword(req.body.password), id);
    log(req, '重設管理員密碼', target.email);
  } else {
    return flash(req, 'error', '密碼至少 8 個字元'), res.redirect('/admin/admins');
  }
  flash(req, 'success', '已更新');
  res.redirect('/admin/admins');
});
router.get('/profile', (req, res) => res.render('admin/profile', { title: '我的帳號', me: get('SELECT name, email FROM admins WHERE id = ?', req.session.admin.id) }));
router.post('/profile', (req, res) => {
  const me = get('SELECT * FROM admins WHERE id = ?', req.session.admin.id);
  const { name, current, password, confirm } = req.body;
  if (password) {
    if (!checkPassword(current || '', me.password)) return flash(req, 'error', '目前密碼錯誤'), res.redirect('/admin/profile');
    if (password.length < 8 || password !== confirm) return flash(req, 'error', '新密碼至少 8 個字元，且兩次輸入要相同'), res.redirect('/admin/profile');
    run('UPDATE admins SET password = ? WHERE id = ?', hashPassword(password), me.id);
    log(req, '變更自己的密碼');
  }
  if (name && name !== me.name) run('UPDATE admins SET name = ? WHERE id = ?', name.trim(), me.id), (req.session.admin.name = name.trim());
  flash(req, 'success', '已儲存');
  res.redirect('/admin/profile');
});

// ---------- 操作紀錄 ----------
router.get('/logs', ownerOnly, (req, res) => {
  const pg = paginate(req, get('SELECT COUNT(*) AS n FROM logs').n, 50);
  res.render('admin/logs', { title: '操作紀錄', rows: all('SELECT * FROM logs ORDER BY id DESC LIMIT ? OFFSET ?', pg.per, pg.offset), pg });
});

// ---------- AI 搜尋優化（GEO／AEO／AIO） ----------
const track = require('./track');
router.get('/geo', (req, res) => {
  if (req.query.tab === 'track') {
    const days = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
    return res.render('admin/geo-track', {
      title: 'AI 搜尋優化', tab: 'track', t: track.report(days), checks: track.listChecks(),
      tools: track.CHECK_TOOLS, results: track.CHECK_RESULTS, today: new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10),
    });
  }
  const report = geo.audit();
  const tab = geo.CATS[req.query.tab] ? req.query.tab : 'overview';
  if (tab === 'overview') return res.render('admin/geo', { title: 'AI 搜尋優化', tab, report });
  const cat = report.cats[tab];
  const filter = req.query.f || 'issues';
  const items = filter === 'all' ? cat.items : cat.items.filter((i) => i.issues.length);
  res.render('admin/geo-cat', {
    title: 'AI 搜尋優化', tab, cat, items, filter, s: settings(),
    answerBots: geo.ANSWER_BOTS, trainBots: geo.TRAIN_BOTS, summary: geo.siteSummary(), FIX: GEO_FIX[tab],
  });
});
// 每一類可以自動補齊的項目
const GEO_FIX = {
  geo: [['category', '分類介紹段落']],
  aeo: [['summary', '商品重點摘要'], ['faq', '商品常見問答']],
  aio: [['meta', '商品搜尋描述'], ['pages', '頁面搜尋描述']],
};
// 每一類可以調整的設定
const GEO_SETTINGS = {
  geo: (b) => ({ geo_bots_answer: b.geo_bots_answer === 'block' ? 'block' : 'allow', geo_bots_train: b.geo_bots_train === 'block' ? 'block' : 'allow', geo_llms: b.geo_llms ? '1' : '0', llms_summary: String(b.llms_summary || '').trim().slice(0, 1000) }),
  aeo: (b) => ({ aeo_show_summary: b.aeo_show_summary ? '1' : '0', aeo_show_faq: b.aeo_show_faq ? '1' : '0', aeo_faq_ld: b.aeo_faq_ld ? '1' : '0', aeo_faq_max: String(Math.max(3, Math.min(10, Number(b.aeo_faq_max) || 6))), aeo_auto: b.aeo_auto ? '1' : '0' }),
  aio: (b) => ({ aio_ld: b.aio_ld ? '1' : '0', aio_meta_len: String([120, 150, 160].includes(Number(b.aio_meta_len)) ? Number(b.aio_meta_len) : 150), aio_auto: b.aio_auto ? '1' : '0' }),
};
router.post('/geo/checks', (req, res) => {
  const b = req.body;
  if (!String(b.question || '').trim() || !track.CHECK_TOOLS.includes(b.tool) || !track.CHECK_RESULTS[b.result]) {
    flash(req, 'error', '請填寫問題，並選擇 AI 工具和結果');
  } else {
    track.addCheck({ day: /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : new Date().toISOString().slice(0, 10), tool: b.tool, question: String(b.question).trim().slice(0, 300), result: b.result, note: String(b.note || '').slice(0, 500), admin: req.session.admin.name });
    log(req, '新增 AI 搜尋檢查紀錄', `${b.tool}：${String(b.question).slice(0, 40)} → ${track.CHECK_RESULTS[b.result]}`);
    flash(req, 'success', '已記錄');
  }
  res.redirect('/admin/geo?tab=track#checks');
});
router.post('/geo/checks/:id/delete', (req, res) => {
  track.deleteCheck(req.params.id);
  res.redirect('/admin/geo?tab=track#checks');
});
router.post('/geo/fix', (req, res) => {
  const cat = geo.CATS[req.body.cat] ? req.body.cat : null;
  const allowed = cat ? GEO_FIX[cat].map(([k]) => k) : Object.values(GEO_FIX).flat().map(([k]) => k);
  const targets = [].concat(req.body.targets || []).filter((t) => allowed.includes(t));
  const back = '/admin/geo' + (cat ? '?tab=' + cat : '');
  if (!targets.length) return flash(req, 'error', '請至少勾選一個項目'), res.redirect(back);
  const score = () => (cat ? geo.audit().cats[cat].score : geo.audit().score);
  const before = score();
  const n = geo.autoFix({ targets, overwrite: req.body.overwrite === '1' });
  const after = score();
  const parts = [n.meta && `商品搜尋描述 ${n.meta}`, n.summary && `重點摘要 ${n.summary}`, n.faq && `常見問答 ${n.faq}`, n.category && `分類介紹 ${n.category}`, n.pages && `頁面描述 ${n.pages}`].filter(Boolean);
  const label = cat ? geo.CATS[cat].name + ' ' : '';
  log(req, `AI 搜尋自動優化 ${label}`.trim(), `${parts.join('、') || '沒有需要補的項目'}；${label}分數 ${before} → ${after}`);
  flash(req, 'success', parts.length ? `已自動補齊：${parts.join('、')}。${label}分數 ${before} → ${after}` : '目前沒有需要自動補齊的空白欄位');
  res.redirect(back);
});
router.post('/geo/settings', ownerOnly, (req, res) => {
  const cat = GEO_SETTINGS[req.body.cat] ? req.body.cat : null;
  if (!cat) return res.redirect('/admin/geo');
  const vals = GEO_SETTINGS[cat](req.body);
  saveSettings(vals);
  log(req, `更新 ${geo.CATS[cat].name} 設定`, Object.entries(vals).filter(([k]) => k !== 'llms_summary').map(([k, v]) => `${k}=${v}`).join('、'));
  flash(req, 'success', `${geo.CATS[cat].name} 設定已儲存`);
  res.redirect('/admin/geo?tab=' + cat + '#settings');
});
router.get('/geo/suggest/:id', (req, res) => {
  const sug = geo.suggestForProduct(Number(req.params.id));
  if (!sug) return res.status(404).json({ error: '找不到商品' });
  res.json(sug);
});

// ---------- 網站編輯（類似 Odoo） ----------
const cms = require('./cms');
const safeBack = (b) => (typeof b === 'string' && b.startsWith('/') && !b.startsWith('//') && !b.startsWith('/admin') ? b : '/');
router.get('/cms/edit', (req, res) => {
  req.session.editMode = req.query.on === '1';
  if (req.session.editMode) log(req, '進入網站編輯模式');
  res.redirect(safeBack(req.query.back));
});
router.post('/cms/save', (req, res) => {
  const changes = req.body && typeof req.body.changes === 'object' ? req.body.changes : null;
  if (!changes) return res.status(400).json({ error: '沒有要儲存的內容' });
  const contentChanges = {};
  const blockChanges = {};
  for (const [k, v] of Object.entries(changes)) (k.startsWith('pg:') ? blockChanges : contentChanges)[k] = v;
  cms.saveContent(contentChanges);
  cms.applyBlockChanges(blockChanges);
  log(req, '編輯網站內容', `${Object.keys(changes).length} 項：${Object.keys(changes).slice(0, 5).join('、')}`);
  res.json({ ok: true });
});
router.post('/cms/block', (req, res) => {
  try {
    const b = req.body || {};
    cms.blockOp(Number(b.pageId), b);
    const pg = cms.getPageById(b.pageId);
    log(req, '編輯頁面區塊', `${pg ? pg.title : b.pageId}：${b.op}${b.type ? ' ' + (cms.BLOCKS[b.type] || {}).label : ''}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.post('/cms/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '圖片不能超過 5MB' : '上傳失敗' });
    if (!req.file) return res.status(400).json({ error: '請選擇 JPG、PNG、WebP 或 GIF 圖片' });
    res.json({ url: fileUrl(req.file) });
  });
});
router.get('/cms/targets', (req, res) => {
  const catUrl = (c) => `/shop/category/${encodeURIComponent(c.name)}-${c.id}`;
  const prodUrl = (p) => `/shop/${encodeURIComponent(p.name.replace(/[\s/?#]+/g, '-').toLowerCase())}-${p.id}`;
  res.json({
    基本頁面: [
      { title: '首頁', url: '/' }, { title: '所有商品', url: '/shop' }, { title: '聯絡我們', url: '/contactus' },
      { title: '訂單查詢', url: '/order-lookup' }, { title: '會員中心', url: '/my' }, { title: '購物車', url: '/shop/cart' },
    ],
    網站頁面: cms.listPages().filter((p) => p.slug !== 'home').map((p) => ({ title: p.title, url: p.system ? '/' + p.slug : '/p/' + p.slug })),
    商品分類: all('SELECT id, name FROM categories ORDER BY sequence, id').map((c) => ({ title: c.name, url: catUrl(c) })),
    商品: all('SELECT id, name FROM products WHERE published = 1 ORDER BY sequence, id LIMIT 300').map((p) => ({ title: p.name, url: prodUrl(p) })),
  });
});

// 頁面管理
const pageUrl = (p) => (p.slug === 'home' ? '/' : p.system ? '/' + p.slug : '/p/' + p.slug);
router.get('/pages', (req, res) => {
  const rows = cms.listPages().map((p) => ({ ...p, url: pageUrl(p) }));
  res.render('admin/pages', { title: '頁面', rows });
});
const slugOk = (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
router.post('/pages', (req, res) => {
  const title = String(req.body.title || '').trim();
  const slug = String(req.body.slug || '').trim().toLowerCase();
  if (!title) return flash(req, 'error', '請填寫頁面名稱'), res.redirect('/admin/pages');
  if (!slugOk(slug)) return flash(req, 'error', '網址只能用小寫英文、數字和「-」，例如 summer-sale'), res.redirect('/admin/pages');
  if (get('SELECT id FROM pages WHERE slug = ?', slug)) return flash(req, 'error', '這個網址已經被使用'), res.redirect('/admin/pages');
  const tpl = req.body.template;
  const blocks = tpl === 'blank' ? [] : tpl === 'landing'
    ? [{ type: 'banner', data: cms.BLOCKS.banner.data() }, { type: 'cards', data: cms.BLOCKS.cards.data() }, { type: 'products', data: cms.BLOCKS.products.data() }, { type: 'buttons', data: cms.BLOCKS.buttons.data() }]
    : [{ type: 'pagehead', data: { title, text: '' } }, { type: 'richtext', data: cms.BLOCKS.richtext.data() }];
  run('INSERT INTO pages (slug, title, blocks, published) VALUES (?, ?, ?, 0)', slug, title, JSON.stringify(blocks));
  log(req, '新增頁面', `${title}（/p/${slug}）`);
  req.session.editMode = true;
  res.redirect('/p/' + slug);
});
router.post('/pages/:id', (req, res) => {
  const p = cms.getPageById(req.params.id);
  if (!p) return res.redirect('/admin/pages');
  const title = String(req.body.title || p.title).trim();
  let slug = p.slug;
  if (!p.system && req.body.slug !== undefined) {
    const ns = String(req.body.slug).trim().toLowerCase();
    if (!slugOk(ns)) return flash(req, 'error', '網址只能用小寫英文、數字和「-」'), res.redirect('/admin/pages');
    if (ns !== p.slug && get('SELECT id FROM pages WHERE slug = ?', ns)) return flash(req, 'error', '這個網址已經被使用'), res.redirect('/admin/pages');
    slug = ns;
  }
  const published = p.slug === 'home' ? 1 : req.body.published ? 1 : 0;
  run("UPDATE pages SET title = ?, slug = ?, meta_description = ?, published = ?, updated_at = datetime('now','localtime') WHERE id = ?", title, slug, String(req.body.meta_description || ''), published, p.id);
  log(req, '更新頁面設定', title);
  flash(req, 'success', '頁面設定已儲存');
  res.redirect('/admin/pages');
});
router.post('/pages/:id/delete', (req, res) => {
  const p = cms.getPageById(req.params.id);
  if (p && !p.system) {
    run('DELETE FROM pages WHERE id = ?', p.id);
    run('DELETE FROM menus WHERE url = ?', '/p/' + p.slug);
    log(req, '刪除頁面', p.title);
    flash(req, 'success', '頁面已刪除（選單中指向這頁的連結也一併移除）');
  }
  res.redirect('/admin/pages');
});
router.post('/pages/:id/menu', (req, res) => {
  const p = cms.getPageById(req.params.id);
  if (p) {
    const loc = cms.MENU_LOCATIONS[req.body.location] ? req.body.location : 'header';
    const seq = (get('SELECT MAX(sequence) AS m FROM menus WHERE location = ? AND parent_id IS NULL', loc).m || 0) + 1;
    run('INSERT INTO menus (location, label, url, sequence) VALUES (?, ?, ?, ?)', loc, p.title, pageUrl(p), seq);
    log(req, '加入選單', `${p.title} → ${cms.MENU_LOCATIONS[loc]}`);
    flash(req, 'success', `已把「${p.title}」加入${cms.MENU_LOCATIONS[loc]}`);
  }
  res.redirect('/admin/pages');
});

// 選單管理
router.get('/menus', (req, res) => {
  const groups = Object.entries(cms.MENU_LOCATIONS).map(([loc, label]) => ({ loc, label, items: cms.menu(loc) }));
  res.render('admin/menus', { title: '選單', groups, pages: cms.listPages().filter((p) => p.slug !== 'home').map((p) => ({ title: p.title, url: pageUrl(p) })) });
});
router.post('/menus', (req, res) => {
  const loc = cms.MENU_LOCATIONS[req.body.location] ? req.body.location : 'header';
  const label = String(req.body.label || '').trim();
  const url = cms.safeUrl(req.body.url, '');
  if (!label || !url) return flash(req, 'error', '請填寫選單名稱和連結（站內以 / 開頭，或 https:// 開頭）'), res.redirect('/admin/menus#' + loc);
  const parent = Number(req.body.parent_id) || null;
  const seq = (get('SELECT MAX(sequence) AS m FROM menus WHERE location = ? AND parent_id IS ?', loc, parent).m || 0) + 1;
  run('INSERT INTO menus (location, parent_id, label, url, sequence, new_tab) VALUES (?, ?, ?, ?, ?, ?)', loc, parent, label, url, seq, req.body.new_tab ? 1 : 0);
  log(req, '新增選單項目', `${label} → ${url}`);
  flash(req, 'success', '已新增選單項目');
  res.redirect('/admin/menus#' + loc);
});
router.post('/menus/:id', (req, res) => {
  const m = get('SELECT * FROM menus WHERE id = ?', Number(req.params.id));
  if (!m) return res.redirect('/admin/menus');
  if (req.body.action === 'delete') {
    run('DELETE FROM menus WHERE id = ?', m.id);
    log(req, '刪除選單項目', m.label);
  } else if (req.body.action === 'up' || req.body.action === 'down') {
    const sibs = all('SELECT id, sequence FROM menus WHERE location = ? AND parent_id IS ? ORDER BY sequence, id', m.location, m.parent_id);
    const i = sibs.findIndex((x) => x.id === m.id);
    const j = req.body.action === 'up' ? i - 1 : i + 1;
    if (sibs[j]) {
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      tx(() => sibs.forEach((x, k) => run('UPDATE menus SET sequence = ? WHERE id = ?', k + 1, x.id)));
    }
  } else {
    const label = String(req.body.label || '').trim();
    const url = cms.safeUrl(req.body.url, '');
    if (!label || !url) return flash(req, 'error', '名稱和連結不能空白'), res.redirect('/admin/menus#' + m.location);
    run('UPDATE menus SET label = ?, url = ?, new_tab = ? WHERE id = ?', label, url, req.body.new_tab ? 1 : 0, m.id);
    log(req, '修改選單項目', `${label} → ${url}`);
  }
  flash(req, 'success', '選單已更新');
  res.redirect('/admin/menus#' + m.location);
});

router.use((req, res) => res.status(404).render('admin/denied', { title: '找不到頁面', notFound: true }));

module.exports = router;
