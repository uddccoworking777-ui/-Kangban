// 前台資料層（SQLite）
const crypto = require('crypto');
const { all, get, run, tx, hashPassword, checkPassword, settings } = require('./db');
const geo = require('./geo');

const ORDER_STATUS = {
  pending: '待處理',
  paid: '已付款・待出貨',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
};
const PAYMENT_STATUS = { unpaid: '未付款', paid: '已付款', refunded: '已退款' };

const SORTS = {
  featured: { label: '精選', fn: (a, b) => a.sequence - b.sequence || a.id - b.id },
  newest: { label: '最新到貨', fn: (a, b) => String(b.createDate).localeCompare(String(a.createDate)) || b.id - a.id },
  name: { label: '名稱 (A-Z)', fn: (a, b) => a.name.localeCompare(b.name, 'zh-Hant') },
  price_asc: { label: '價格 － 低至高', fn: (a, b) => a.price - b.price },
  price_desc: { label: '價格 － 高至低', fn: (a, b) => b.price - a.price },
};

function toProduct(r) {
  const images = JSON.parse(r.images || '[]');
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    price: r.price,
    comparePrice: r.compare_price && r.compare_price > r.price ? r.compare_price : null,
    stock: r.stock,
    trackStock: Boolean(r.track_stock),
    soldOut: Boolean(r.track_stock) && r.stock <= 0,
    brandIds: r.brand_id ? [r.brand_id] : [],
    categoryIds: r.cat_ids ? String(r.cat_ids).split(',').map(Number) : [],
    description: r.description || '',
    descriptionHtml: r.description_html || '',
    licenseNo: r.license_no || '',
    metaDescription: r.meta_description || '',
    summary: String(r.summary || '').split('\n').map((s) => s.trim()).filter(Boolean),
    faq: geo.parseFaq(r.faq),
    updatedAt: r.updated_at,
    isMedical: Boolean(r.is_medical) || Boolean(r.license_no),
    licenseHolder: r.license_holder || '',
    manufacturer: r.manufacturer || '',
    origin: r.origin || '',
    spec: r.spec || '',
    sizeChart: r.size_chart || '',
    precautions: r.precautions || '',
    soldCount: r.sold_count || 0,
    image: r.image || images[0] || '/img/logo.webp',
    images: images.filter((x) => x !== r.image),
    published: Boolean(r.published),
    popular: Boolean(r.featured),
    sequence: r.sequence,
    createDate: r.created_at,
  };
}

const PRODUCT_SQL = `SELECT p.*, (SELECT group_concat(category_id) FROM product_categories pc WHERE pc.product_id = p.id) AS cat_ids FROM products p`;

function publishedProducts() {
  return all(`${PRODUCT_SQL} WHERE p.published = 1`).map(toProduct);
}

async function categories() {
  return all('SELECT id, name, parent_id AS parentId, sequence, icon, description, seo_intro AS seoIntro FROM categories WHERE published = 1 ORDER BY sequence, id').map((c) => ({
    ...c,
    icon: c.icon || '/img/logo.webp',
  }));
}
async function brands() {
  return all('SELECT id, name, logo FROM brands ORDER BY sequence, id');
}

function descendants(cats, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cats) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) out.add(c.id), (grew = true);
  }
  return out;
}

async function listProducts({ categoryId, brandIds = [], q = '', sort = 'featured', minPrice, maxPrice, page = 1, perPage = 20 } = {}) {
  let list = publishedProducts();
  if (categoryId) {
    const ids = descendants(await categories(), Number(categoryId));
    list = list.filter((p) => p.categoryIds.some((c) => ids.has(c)));
  }
  if (brandIds.length) list = list.filter((p) => p.brandIds.some((b) => brandIds.includes(b)));
  if (q) {
    const s = q.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(s) || p.description.toLowerCase().includes(s) || (p.sku || '').toLowerCase() === s);
  }
  if (minPrice != null && minPrice !== '') list = list.filter((p) => p.price >= Number(minPrice));
  if (maxPrice != null && maxPrice !== '') list = list.filter((p) => p.price <= Number(maxPrice));
  list.sort((SORTS[sort] || SORTS.featured).fn);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(1, Number(page) || 1), pages);
  return { items: list.slice((page - 1) * perPage, page * perPage), total, page, pages };
}

async function getProduct(id) {
  const r = get(`${PRODUCT_SQL} WHERE p.id = ? AND p.published = 1`, Number(id));
  return r ? toProduct(r) : null;
}
async function getProducts(ids) {
  const map = new Map(publishedProducts().map((p) => [p.id, p]));
  return ids.map((id) => map.get(Number(id))).filter(Boolean);
}
// 最受歡迎：依實際銷量排序；銷量相同時，後台勾選「熱門」的優先，再依排序值
async function popularProducts(n = 8) {
  return publishedProducts()
    .filter((p) => !p.soldOut)
    .sort((a, b) => b.soldCount - a.soldCount || Number(b.popular) - Number(a.popular) || a.sequence - b.sequence)
    .slice(0, n);
}
async function categoryCounts() {
  return Object.fromEntries(all('SELECT pc.category_id AS id, COUNT(*) AS n FROM product_categories pc JOIN products p ON p.id = pc.product_id AND p.published = 1 GROUP BY pc.category_id').map((r) => [r.id, r.n]));
}
async function newestProducts(n = 8) {
  return publishedProducts().sort(SORTS.newest.fn).slice(0, n);
}
async function relatedProducts(product, n = 4) {
  return publishedProducts()
    .filter((p) => p.id !== product.id && p.categoryIds.some((c) => product.categoryIds.includes(c)))
    .slice(0, n);
}

// ---------------- 會員 ----------------
const publicUser = (c) => ({ userId: c.id, customerId: c.id, name: c.name, email: c.email });

async function signup({ name, email, password }) {
  const existing = get('SELECT * FROM customers WHERE email = ?', email);
  if (existing?.password) throw new Error('此 Email 已註冊，請直接登入');
  if (existing) {
    // 之前以訪客身分下單過：直接把帳號開通，歷史訂單會自動帶入
    run('UPDATE customers SET name = ?, password = ? WHERE id = ?', name, hashPassword(password), existing.id);
    return publicUser({ ...existing, name });
  }
  const r = run('INSERT INTO customers (name, email, password) VALUES (?, ?, ?)', name, email, hashPassword(password));
  return publicUser({ id: Number(r.lastInsertRowid), name, email });
}

async function login(email, password) {
  const c = get('SELECT * FROM customers WHERE email = ?', email);
  if (!c || !checkPassword(password, c.password)) return null;
  return publicUser(c);
}

async function getCustomer(id) {
  return get('SELECT id, name, email, phone, zip, city, street FROM customers WHERE id = ?', id) || null;
}
async function updateCustomer(id, { name, phone, zip, city, street }) {
  run('UPDATE customers SET name = COALESCE(NULLIF(?, \'\'), name), phone = ?, zip = ?, city = ?, street = ? WHERE id = ?', name || '', phone || '', zip || '', city || '', street || '', id);
}

// ---------------- 管理員（前台登入時一併登入後台） ----------------
function adminLogin(email, password) {
  const a = get('SELECT * FROM admins WHERE email = ? AND active = 1', email);
  if (!a || !checkPassword(password, a.password)) return null;
  run("UPDATE admins SET last_login = datetime('now','localtime') WHERE id = ?", a.id);
  return { id: a.id, name: a.name, role: a.role };
}
// 前台判斷是否顯示「管理後台」入口：必須是目前仍為啟用狀態的管理員
function activeAdmin(session) {
  if (!session.admin) return null;
  const a = get('SELECT id, name, role FROM admins WHERE id = ? AND active = 1', session.admin.id);
  if (!a) delete session.admin;
  return a || null;
}
function logAdmin(admin, action, detail = '') {
  run('INSERT INTO logs (admin_id, admin_name, action, detail) VALUES (?, ?, ?, ?)', admin.id, admin.name, action, detail);
}

// ---------------- 訂單 ----------------
class StockError extends Error {}

function createOrder({ customer, lines, shipping, payment, invoice, note, customerId, source }) {
  return tx(() => {
    // 檢查並扣庫存
    for (const l of lines) {
      const p = get('SELECT id, name, stock, track_stock, published FROM products WHERE id = ?', l.product.id);
      if (!p || !p.published) throw new StockError(`「${l.product.name}」已下架`);
      if (p.track_stock && p.stock < l.qty) throw new StockError(`「${p.name}」庫存不足（剩 ${Math.max(0, p.stock)} 件）`);
    }
    for (const l of lines) run('UPDATE products SET stock = stock - CASE WHEN track_stock = 1 THEN ? ELSE 0 END, sold_count = sold_count + ? WHERE id = ?', l.qty, l.qty, l.product.id);

    // 客戶：已登入用會員；未登入以 Email 找（或建立）訪客資料
    let cid = customerId;
    if (!cid) {
      const c = get('SELECT id FROM customers WHERE email = ?', customer.email);
      cid = c ? c.id : Number(run('INSERT INTO customers (name, email) VALUES (?, ?)', customer.name, customer.email).lastInsertRowid);
    }
    run(
      'UPDATE customers SET phone = COALESCE(NULLIF(?, \'\'), phone), zip = COALESCE(NULLIF(?, \'\'), zip), city = COALESCE(NULLIF(?, \'\'), city), street = COALESCE(NULLIF(?, \'\'), street) WHERE id = ?',
      customer.phone || '', customer.zip || '', customer.city || '', customer.street || '', cid
    );

    const subtotal = lines.reduce((s, l) => s + l.product.price * l.qty, 0);
    const total = subtotal + shipping.fee;
    const r = run(
      `INSERT INTO orders (customer_id, customer_name, email, phone, zip, city, street, cvs_store, shipping_method, shipping_fee,
        payment_method, invoice_type, invoice_detail, vat, company_name, note, subtotal, total, access_token, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cid, customer.name, customer.email, customer.phone, customer.zip || '', customer.city || '', customer.street || '', customer.cvsStore || '',
      shipping.code, shipping.fee, payment.code, invoice.code, invoice.detail || '', invoice.vat || '', invoice.companyName || '',
      note || '', subtotal, total, crypto.randomBytes(16).toString('hex'), source || null
    );
    const orderId = Number(r.lastInsertRowid);
    run('UPDATE orders SET name = ? WHERE id = ?', 'S' + String(orderId).padStart(5, '0'), orderId);
    for (const l of lines) {
      run(
        'INSERT INTO order_items (order_id, product_id, name, sku, price, qty, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?)',
        orderId, l.product.id, l.product.name, l.product.sku || '', l.product.price, l.qty, l.product.price * l.qty
      );
    }
    return getOrder(orderId);
  });
}

function getOrder(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', Number(id));
  if (!o) return null;
  o.items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', o.id);
  return o;
}

function findOrder(name, email) {
  return get('SELECT id FROM orders WHERE name = ? AND lower(email) = ?', name, email) || null;
}

async function listOrders(customerId) {
  return all('SELECT id, name, created_at, status, payment_status, total FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100', customerId);
}

// ---------------- 聯絡表單 ----------------
async function createContact({ name, email, phone, orderRef, message }) {
  run('INSERT INTO messages (name, email, phone, order_ref, message) VALUES (?, ?, ?, ?, ?)', name, email, phone || '', orderRef || '', message);
}

module.exports = {
  SORTS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  StockError,
  settings,
  categories,
  brands,
  listProducts,
  getProduct,
  getProducts,
  popularProducts,
  categoryCounts,
  newestProducts,
  relatedProducts,
  signup,
  login,
  adminLogin,
  activeAdmin,
  logAdmin,
  getCustomer,
  updateCustomer,
  createOrder,
  getOrder,
  findOrder,
  listOrders,
  createContact,
  toProduct,
  PRODUCT_SQL,
};
