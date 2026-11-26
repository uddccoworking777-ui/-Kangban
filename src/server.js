require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const SqliteStore = require('./session-store');
const store = require('./store');
const geo = require('./geo');
const cms = require('./cms');
cms.init(path.join(__dirname, '..', 'views'));
const { settings } = require('./db');

const app = express();

// 靜態檔版本號：檔案一改，網址就跟著變，瀏覽器會自動抓新版（不用手動清快取）
const fs = require('fs');
const PUBLIC = path.join(__dirname, '..', 'public');
const assetCache = {};
function asset(file) {
  try {
    const m = fs.statSync(path.join(PUBLIC, file)).mtimeMs;
    if (!assetCache[file] || assetCache[file].m !== m) assetCache[file] = { m, url: `/${file}?v=${Math.round(m).toString(36)}` };
    return assetCache[file].url;
  } catch {
    return '/' + file;
  }
}
const PORT = Number(process.env.PORT || 3000);

const { PAYMENTS, INVOICES, SHIPPING } = require('./constants');
function shipOptions() {
  const s = settings();
  return {
    home: { code: 'home', label: SHIPPING.home, fee: Number(s.shipping_home || 0) },
    cvs: { code: 'cvs', label: SHIPPING.cvs, fee: Number(s.shipping_cvs || 0) },
  };
}
const freeShip = () => Number(settings().free_shipping_threshold || 0);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(
  express.static(PUBLIC, {
    setHeaders(res, file) {
      // CSS／JS 每次確認是否有新版；圖片可以快取 7 天
      res.setHeader('Cache-Control', /\.(css|js)$/.test(file) ? 'no-cache' : 'public, max-age=604800');
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    store: new SqliteStore(),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);

// ---------- 共用工具 ----------
const money = (n) => 'NT$ ' + Math.round(Number(n) || 0).toLocaleString('en-US');
const slug = (p) => `/shop/${encodeURIComponent(p.name.replace(/[\s/?#]+/g, '-').toLowerCase())}-${p.id}`;
const catUrl = (c) => `/shop/category/${encodeURIComponent(c.name)}-${c.id}`;
const wantsJson = (req) => req.xhr || (req.get('accept') || '').includes('application/json');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// CSRF 與共用變數（前台、後台都會用）
app.use((req, res, next) => {
  const s = req.session;
  s.csrf ||= crypto.randomBytes(16).toString('hex');
  if (req.method === 'POST') {
    const token = req.body?._csrf || req.query._csrf || req.get('x-csrf-token');
    if (token !== s.csrf) return res.status(403).send('表單已過期，請重新整理頁面後再試一次。');
  }
  res.locals.csrf = s.csrf;
  res.locals.asset = asset;
  res.locals.money = money;
  res.locals.settings = settings();
  next();
});

// AI 搜尋成效追蹤（爬蟲造訪、從 AI 點進來的訪客；不記錄 IP）
app.use(require('./track').middleware);

app.use('/admin', require('./admin'));

app.use(async (req, res, next) => {
  const s = req.session;
  s.cart ||= {};
  s.wishlist ||= [];
  s.compare ||= [];
  Object.assign(res.locals, {
    categories: await store.categories(),
    brandMap: Object.fromEntries((await store.brands()).map((b) => [b.id, b.name])),
    siteName: settings().store_name,
    path: req.path,
    query: req.query,
    user: s.user || null,
    adminUser: store.activeAdmin(s),
    editing: Boolean(store.activeAdmin(s) && s.editMode),
    currentUrl: req.originalUrl,
    BLOCKS: cms.BLOCKS,
    SYS_SECTIONS: cms.SYS_SECTIONS,
    blockEditor: cms.blockEditor,
    menus: { header: cms.menu('header'), util: cms.menu('util'), footer1: cms.menu('footer1'), footer2: cms.menu('footer2') },
    cartCount: Object.values(s.cart).reduce((a, b) => a + b, 0),
    wishlistCount: s.wishlist.length,
    wishlist: s.wishlist,
    compare: s.compare,
    flash: s.flash || null,
    slug,
    catUrl,
    year: new Date().getFullYear(),
    freeShip: freeShip(),
    ship: shipOptions(),
    siteUrl: `${req.protocol}://${req.get('host')}`,
    canonical: `${req.protocol}://${req.get('host')}${req.path}`,
  });
  delete s.flash;
  res.locals.E = cms.editor(res.locals.editing);
  next();
});

function flash(req, type, text) {
  req.session.flash = { type, text };
}

async function cartDetails(cart) {
  const products = await store.getProducts(Object.keys(cart));
  const lines = products.map((p) => ({ product: p, qty: cart[p.id], subtotal: p.price * cart[p.id] }));
  // 已下架的商品自動移出購物車
  for (const id of Object.keys(cart)) if (!products.some((p) => p.id === Number(id))) delete cart[id];
  const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
  return { lines, subtotal };
}
function shippingFee(method, subtotal) {
  const m = shipOptions()[method] || shipOptions().home;
  return subtotal >= freeShip() || subtotal === 0 ? 0 : m.fee;
}

// ---------- 首頁 ----------
app.get(
  '/',
  ah(async (req, res) => {
    const [newest, popular, brands, counts] = await Promise.all([store.newestProducts(12), store.popularProducts(10), store.brands(), store.categoryCounts()]);
    const homePage = await withProducts(cms.getPage('home', true));
    const present = new Set(homePage.blocks.filter((b) => b.type === 'sys').map((b) => b.data.id));
    const homeMissing = Object.entries(cms.SYS_SECTIONS).filter(([id]) => !present.has(id));
    res.render('pages/home', { title: '首頁', newest, popular, brands, counts, homePage, page: homePage, homeMissing });
  })
);

// ---------- 商店 ----------
async function renderShop(req, res, category) {
  const brandIds = [].concat(req.query.brand || []).map(Number).filter(Boolean);
  const sort = store.SORTS[req.query.sort] ? req.query.sort : 'featured';
  const result = await store.listProducts({
    categoryId: category?.id,
    brandIds,
    q: String(req.query.search || '').trim(),
    sort,
    minPrice: req.query.min_price,
    maxPrice: req.query.max_price,
    page: req.query.page,
  });
  res.render('pages/shop', {
    title: category ? category.name : '商店',
    metaDescription: category ? geo.clip(category.seoIntro || category.description || '', 155) || undefined : undefined,
    category,
    result,
    brands: await store.brands(),
    brandIds,
    sort,
    sorts: store.SORTS,
    search: String(req.query.search || ''),
  });
}
app.get('/shop', ah((req, res) => renderShop(req, res, null)));
app.get(
  '/shop/category/:slug',
  ah(async (req, res, next) => {
    const id = Number(String(req.params.slug).split('-').pop());
    const category = res.locals.categories.find((c) => c.id === id);
    if (!category) return next();
    return renderShop(req, res, category);
  })
);

// ---------- 購物車 ----------
app.get(
  '/shop/cart',
  ah(async (req, res) => {
    const { lines, subtotal } = await cartDetails(req.session.cart);
    const fee = shippingFee('home', subtotal);
    res.render('pages/cart', { title: '購物車', lines, subtotal, fee, suggestions: await store.popularProducts(4) });
  })
);
app.post(
  '/shop/cart/update',
  ah(async (req, res) => {
    const id = Number(req.body.product_id);
    const p = await store.getProduct(id);
    if (!p) return wantsJson(req) ? res.status(404).json({ error: '找不到商品' }) : res.redirect('/shop');
    const cart = req.session.cart;
    const setQty = req.body.set_qty != null && req.body.set_qty !== '' ? Number(req.body.set_qty) : null;
    const add = Number(req.body.add_qty || 1);
    let qty = setQty != null ? setQty : (cart[id] || 0) + add;
    qty = Math.max(0, Math.min(999, Math.floor(qty) || 0));
    let warning = null;
    if (p.trackStock && qty > p.stock) {
      qty = Math.max(0, p.stock);
      warning = p.stock > 0 ? `「${p.name}」庫存只剩 ${p.stock} 件` : `「${p.name}」已售完`;
    }
    if (qty) cart[id] = qty;
    else delete cart[id];
    const count = Object.values(cart).reduce((a, b) => a + b, 0);
    if (wantsJson(req)) {
      const { subtotal, lines } = await cartDetails(cart);
      const fee = shippingFee('home', subtotal);
      const line = lines.find((l) => l.product.id === id);
      return res.json({
        count,
        qty,
        warning,
        lineSubtotal: money(line ? line.subtotal : 0),
        subtotal: money(subtotal),
        subtotalRaw: subtotal,
        fee: fee ? money(fee) : '免運',
        total: money(subtotal + fee),
        name: p.name,
      });
    }
    if (warning) {
      flash(req, 'error', warning);
      return res.redirect(req.get('referer') || '/shop/cart');
    }
    if (req.body.express) return res.redirect('/shop/checkout');
    flash(req, 'success', `已將「${p.name}」加入購物車`);
    res.redirect(req.get('referer') || '/shop/cart');
  })
);

// ---------- 願望清單 / 比較 ----------
function toggleList(key, max) {
  return ah(async (req, res) => {
    const id = Number(req.body.product_id);
    const list = req.session[key];
    const i = list.indexOf(id);
    let active;
    if (i >= 0) list.splice(i, 1), (active = false);
    else {
      if (!(await store.getProduct(id))) return res.status(404).json({ error: '找不到商品' });
      if (max && list.length >= max) list.shift();
      list.push(id);
      active = true;
    }
    if (wantsJson(req)) return res.json({ active, count: list.length });
    res.redirect(req.get('referer') || '/shop');
  });
}
app.post('/shop/wishlist/toggle', toggleList('wishlist'));
app.post('/shop/compare/toggle', toggleList('compare', 4));
app.get(
  '/shop/wishlist',
  ah(async (req, res) => res.render('pages/wishlist', { title: '願望清單', products: await store.getProducts(req.session.wishlist) }))
);
app.get(
  '/shop/compare',
  ah(async (req, res) => {
    const products = await store.getProducts(req.session.compare);
    res.render('pages/compare', { title: '比較商品', products, brands: await store.brands() });
  })
);

// ---------- 結帳 ----------
function renderCheckout(res, data, status = 200) {
  res.status(status).render('pages/checkout', { title: '結帳', payments: PAYMENTS, invoices: INVOICES, errors: {}, ...data });
}
app.get(
  '/shop/checkout',
  ah(async (req, res) => {
    const { lines, subtotal } = await cartDetails(req.session.cart);
    if (!lines.length) return res.redirect('/shop/cart');
    const customer = req.session.user ? await store.getCustomer(req.session.user.customerId) : null;
    renderCheckout(res, { lines, subtotal, form: req.session.checkoutForm || customer || {} });
  })
);
app.post(
  '/shop/checkout',
  ah(async (req, res) => {
    const { lines, subtotal } = await cartDetails(req.session.cart);
    if (!lines.length) return res.redirect('/shop/cart');
    const f = Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    const SHIP = shipOptions();
    const errors = {};
    if (!f.name) errors.name = '請填寫收件人姓名';
    if (!/^\S+@\S+\.\S+$/.test(f.email || '')) errors.email = '請填寫正確的 Email';
    if (!/^[0-9+\-\s()]{8,20}$/.test(f.phone || '')) errors.phone = '請填寫正確的手機號碼';
    if (!SHIP[f.shipping]) errors.shipping = '請選擇配送方式';
    if (f.shipping === 'home' && (!f.city || !f.street)) errors.street = '宅配請填寫完整地址';
    if (f.shipping === 'cvs' && !f.cvs_store) errors.cvs_store = '請填寫取貨門市';
    if (!PAYMENTS[f.payment]) errors.payment = '請選擇付款方式';
    if (f.payment === 'cod' && f.shipping !== 'cvs') errors.payment = '超商取貨付款需選擇超商取貨';
    if (!INVOICES[f.invoice]) errors.invoice = '請選擇發票類型';
    if (f.invoice === 'company' && !/^\d{8}$/.test(f.vat || '')) errors.vat = '統一編號為 8 位數字';
    if (f.invoice === 'mobile' && !/^\/[0-9A-Z.+-]{7}$/.test(f.carrier || '')) errors.carrier = '手機條碼格式為 / 開頭共 8 碼';
    if (!f.agree) errors.agree = '請閱讀並同意購物須知與退換貨政策';
    if (Object.keys(errors).length) return renderCheckout(res, { lines, subtotal, form: f, errors }, 400);

    const fee = shippingFee(f.shipping, subtotal);
    const invoiceDetail = f.invoice === 'mobile' ? f.carrier : f.invoice === 'donate' ? f.donate_code || '' : '';
    let order;
    try {
      order = store.createOrder({
        customer: { name: f.name, email: f.email, phone: f.phone, zip: f.zip, city: f.city, street: f.shipping === 'home' ? f.street : '', cvsStore: f.shipping === 'cvs' ? f.cvs_store : '' },
        lines,
        shipping: { code: f.shipping, fee },
        payment: { code: f.payment },
        invoice: { code: f.invoice, detail: invoiceDetail, vat: f.invoice === 'company' ? f.vat : '', companyName: f.invoice === 'company' ? f.company_name : '' },
        note: f.note,
        customerId: req.session.user?.customerId,
        source: req.session.aiSource || null, // 從哪個 AI 點進來（成效追蹤用）
      });
    } catch (e) {
      if (e instanceof store.StockError) return renderCheckout(res, { lines, subtotal, form: f, errors: { stock: e.message } }, 409);
      throw e;
    }
    req.session.cart = {};
    req.session.myOrders = [...(req.session.myOrders || []), order.id];
    req.session.checkoutForm = { name: f.name, email: f.email, phone: f.phone, zip: f.zip, city: f.city, street: f.street };
    res.redirect(`/shop/confirmation/${order.id}`);
  })
);
app.get('/shop/confirmation/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!(req.session.myOrders || []).includes(id)) return next();
  const order = store.getOrder(id);
  if (!order) return next();
  res.render('pages/confirmation', { title: '訂單已成立', order, payments: PAYMENTS, invoices: INVOICES, ship: shipOptions() });
});

// ---------- 搜尋 API ----------
app.get(
  '/api/search',
  ah(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ total: 0, items: [] });
    const r = await store.listProducts({ q, perPage: 6 });
    res.json({ total: r.total, items: r.items.map((p) => ({ name: p.name, price: money(p.price), url: slug(p), image: p.image })) });
  })
);

// ---------- 會員 ----------
const safeRedirect = (r) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : '/my');
app.get('/web/login', (req, res) => res.render('pages/login', { title: '登入', mode: 'login', form: {}, error: null, redirect: safeRedirect(req.query.redirect) }));
app.get('/web/signup', (req, res) => res.render('pages/login', { title: '註冊', mode: 'signup', form: {}, error: null, redirect: safeRedirect(req.query.redirect) }));
// 登入失敗次數限制（同一 IP＋帳號連續錯 5 次，鎖 10 分鐘）
const loginTries = new Map();
app.post(
  '/web/login',
  ah(async (req, res) => {
    const { login, password } = req.body;
    const email = String(login || '').trim();
    const fail = (error, status = 401) =>
      res.status(status).render('pages/login', { title: '登入', mode: 'login', form: req.body, error, redirect: safeRedirect(req.body.redirect) });
    const key = req.ip + '|' + email.toLowerCase();
    const t = loginTries.get(key) || { n: 0, until: 0 };
    if (t.until > Date.now()) return fail('登入失敗次數過多，請 10 分鐘後再試', 429);

    // 同時比對會員帳號與管理員帳號：管理員用同一組帳密登入前台，就不用另外登入後台
    const user = email && password ? await store.login(email, password) : null;
    const admin = email && password ? store.adminLogin(email, password) : null;
    if (!user && !admin) {
      t.n += 1;
      if (t.n >= 5) (t.until = Date.now() + 10 * 60 * 1000), (t.n = 0);
      loginTries.set(key, t);
      return fail('帳號或密碼錯誤');
    }
    loginTries.delete(key);
    const { cart, wishlist, compare } = req.session;
    req.session.regenerate((err) => {
      if (err) return res.redirect('/web/login');
      Object.assign(req.session, { cart, wishlist, compare });
      if (user) req.session.user = user;
      if (admin) {
        req.session.admin = admin;
        store.logAdmin(admin, '從前台登入');
      }
      let to = safeRedirect(req.body.redirect);
      if (!user && to.startsWith('/my')) to = '/'; // 只有管理員身分、沒有會員帳號時，不導到會員中心
      if (admin) flash(req, 'success', `${admin.name} 您好，已同時登入管理後台，可從右上角選單進入。`);
      res.redirect(to);
    });
  })
);
app.post(
  '/web/signup',
  ah(async (req, res) => {
    const { name, login, password, confirm_password } = req.body;
    const render = (error) => res.status(400).render('pages/login', { title: '註冊', mode: 'signup', form: req.body, error, redirect: safeRedirect(req.body.redirect) });
    if (!name || !login || !password) return render('請填寫所有欄位');
    if (!/^\S+@\S+\.\S+$/.test(login)) return render('請填寫正確的 Email');
    if (password.length < 8) return render('密碼至少 8 個字元');
    if (password !== confirm_password) return render('兩次輸入的密碼不一致');
    let user;
    try {
      user = await store.signup({ name: name.trim(), email: login.trim(), password });
    } catch (e) {
      return render(e.message);
    }
    const { cart, wishlist, compare } = req.session;
    req.session.regenerate(() => {
      Object.assign(req.session, { user, cart, wishlist, compare });
      flash(req, 'success', '註冊成功，歡迎加入！');
      res.redirect(safeRedirect(req.body.redirect));
    });
  })
);
app.get('/web/session/logout', (req, res) => {
  delete req.session.user;
  delete req.session.admin; // 從前台登出時，後台也一併登出
  res.redirect('/');
});

function requireUser(req, res, next) {
  if (!req.session.user) return res.redirect('/web/login?redirect=' + encodeURIComponent(req.originalUrl));
  next();
}
app.get(
  '/my',
  requireUser,
  ah(async (req, res) => {
    const id = req.session.user.customerId;
    const [customer, orders] = await Promise.all([store.getCustomer(id), store.listOrders(id)]);
    res.render('pages/account', { title: '我的帳戶', customer, orders, states: store.ORDER_STATUS });
  })
);
app.post(
  '/my/account',
  requireUser,
  ah(async (req, res) => {
    await store.updateCustomer(req.session.user.customerId, req.body);
    if (req.body.name) req.session.user.name = req.body.name;
    flash(req, 'success', '資料已更新');
    res.redirect('/my');
  })
);
app.get('/my/orders/:id', requireUser, (req, res, next) => {
  const order = store.getOrder(req.params.id);
  if (!order || order.customer_id !== req.session.user.customerId) return next();
  res.render('pages/order', { title: `訂單 ${order.name}`, order, states: store.ORDER_STATUS, payments: PAYMENTS, invoices: INVOICES, ship: shipOptions() });
});

// ---------- 聯絡我們 ----------
app.get('/contactus', (req, res) =>
  res.render('pages/contactus', { title: '聯絡我們', form: req.session.user ? { name: req.session.user.name, email: req.session.user.email } : {}, errors: {} })
);
app.post(
  '/contactus',
  ah(async (req, res) => {
    const f = req.body;
    if (f.website) return res.redirect('/contactus-thank-you'); // 防垃圾訊息的隱藏欄位
    const errors = {};
    if (!f.name?.trim()) errors.name = '請填寫姓名';
    if (!/^\S+@\S+\.\S+$/.test(f.email || '')) errors.email = '請填寫正確的 Email';
    if (!f.message?.trim()) errors.message = '請填寫問題內容';
    if (Object.keys(errors).length) return res.status(400).render('pages/contactus', { title: '聯絡我們', form: f, errors });
    await store.createContact({ name: f.name.trim(), email: f.email.trim(), phone: f.phone, orderRef: f.order_ref, message: f.message.trim().slice(0, 5000) });
    res.redirect('/contactus-thank-you');
  })
);
app.get('/contactus-thank-you', (req, res) => res.render('pages/thanks', { title: '感謝您的來信' }));

// ---------- 訂單查詢（不用登入） ----------
const lookupTries = new Map();
app.get('/order-lookup', (req, res) => res.render('pages/order-lookup', { title: '訂單查詢', form: {}, error: null }));
app.post('/order-lookup', (req, res) => {
  const key = req.ip;
  const t = lookupTries.get(key) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60 * 1000) (t.n = 0), (t.at = Date.now());
  t.n += 1;
  lookupTries.set(key, t);
  const name = String(req.body.order_no || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (t.n > 10) return res.status(429).render('pages/order-lookup', { title: '訂單查詢', form: req.body, error: '查詢次數過多，請 15 分鐘後再試' });
  const found = store.findOrder(name, email);
  if (!found) return res.status(404).render('pages/order-lookup', { title: '訂單查詢', form: req.body, error: '查無此訂單，請確認訂單編號與 Email 是否正確' });
  req.session.myOrders = [...new Set([...(req.session.myOrders || []), found.id])];
  res.redirect('/order-lookup/' + found.id);
});
app.get('/order-lookup/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!(req.session.myOrders || []).includes(id)) return res.redirect('/order-lookup');
  const order = store.getOrder(id);
  if (!order) return next();
  res.render('pages/order', { title: `訂單 ${order.name}`, order, states: store.ORDER_STATUS, payments: PAYMENTS, invoices: INVOICES, ship: shipOptions(), guest: true });
});

// ---------- SEO ----------
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
app.get('/robots.txt', (req, res) => res.type('text/plain').send(geo.robotsTxt(baseUrl(req))));
// 給 AI 搜尋引擎讀的網站摘要（llmstxt.org 格式）
const llmsOn = (req, res, next) => (settings().geo_llms === '0' ? next() : res.type('text/plain; charset=utf-8').send(geo.llmsTxt(baseUrl(req), req.path === '/llms-full.txt')));
app.get(['/llms.txt', '/llms-full.txt'], llmsOn);
app.get(
  '/sitemap.xml',
  ah(async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const urls = ['/', '/shop', ...Object.keys(PAGES).map((p) => '/' + p), '/contactus'];
    for (const pg of cms.listPages()) if (pg.published && !pg.system) urls.push('/p/' + pg.slug);
    for (const c of await store.categories()) urls.push(catUrl(c));
    const lastmod = {};
    for (const p of (await store.listProducts({ perPage: 10000 })).items) urls.push(slug(p)), (lastmod[slug(p)] = String(p.updatedAt || '').slice(0, 10));
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${base}${u}</loc>${lastmod[u] ? `<lastmod>${lastmod[u]}</lastmod>` : ''}</url>`).join('')}</urlset>`);
  })
);

// ---------- 內容頁（可在前台編輯） ----------
// 商品列區塊需要先抓商品資料
async function withProducts(page) {
  if (!page) return page;
  for (const b of page.blocks) {
    if (b.type !== 'products') continue;
    const n = Math.max(1, Math.min(20, Number(b.data.count) || 8));
    const src = String(b.data.source || 'popular');
    if (src === 'newest') b._products = await store.newestProducts(n);
    else if (src.startsWith('cat:')) b._products = (await store.listProducts({ categoryId: Number(src.slice(4)), perPage: n })).items;
    else b._products = await store.popularProducts(n);
  }
  return page;
}
async function renderCmsPage(req, res, slug, fallback) {
  const page = await withProducts(cms.getPage(slug, res.locals.editing));
  if (!page) return fallback ? fallback() : null;
  const head = page.blocks.find((b) => b.type === 'pagehead');
  return res.render('pages/page', { title: page.title, page, faqLd: geo.faqFromBlocks(page.blocks), metaDescription: page.meta_description || (head && head.data.text) || undefined });
}
const PAGES = { 'about-us': '關於我們', fqa: '常見問題', 'return-policy': '退換貨政策', 'shopping-guide': '購物須知', terms: '條款及條件', privacy: '私隱政策' };
for (const [p, title] of Object.entries(PAGES)) {
  app.get('/' + p, ah((req, res) => renderCmsPage(req, res, p, () => res.render('pages/' + p, { title }))));
}
app.get('/p/:slug', ah((req, res, next) => renderCmsPage(req, res, req.params.slug, next)));
app.get('/faq', (req, res) => res.redirect(301, '/fqa'));

// ---------- 商品頁（放最後，避免吃掉 /shop/cart 等路徑） ----------
app.get(
  '/shop/:slug',
  ah(async (req, res, next) => {
    const m = /-(\d+)$/.exec(req.params.slug);
    if (!m) return next();
    const product = await store.getProduct(m[1]);
    if (!product) return next();
    const recentIds = (req.session.recent || []).filter((x) => x !== product.id);
    req.session.recent = [product.id, ...recentIds].slice(0, 9);
    const [related, brands, recent] = await Promise.all([store.relatedProducts(product), store.brands(), store.getProducts(recentIds.slice(0, 4))]);
    const category = res.locals.categories.find((c) => product.categoryIds.includes(c.id));
    res.render('pages/product', {
      title: product.name,
      product,
      related,
      category,
      productBrands: brands.filter((b) => product.brandIds.includes(b.id)),
      recent,
      metaDescription: product.metaDescription || geo.clip(product.description, 150),
      ogImage: product.image,
    });
  })
);

// ---------- 錯誤處理 ----------
app.use((req, res) => res.status(404).render('pages/error', { title: '找不到頁面', code: 404, message: '您要找的頁面不存在或已移除。' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/admin')) return res.status(500).send('系統錯誤：' + err.message);
  res.status(500).render('pages/error', { title: '系統忙碌中', code: 500, message: '系統暫時無法處理您的要求，請稍後再試，或透過「聯絡我們」告訴我們。' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${settings().store_name} 網站已啟動：http://localhost:${PORT}`);
    console.log(`管理後台：http://localhost:${PORT}/admin`);
  });
}
module.exports = { app };
