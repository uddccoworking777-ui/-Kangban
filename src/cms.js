// 網站內容管理（類似 Odoo 網站編輯器）
//  - content：頁面上可編輯的文字／圖片／按鈕（以 key 儲存）
//  - pages：自訂頁面（由區塊組成）
//  - menus：頁首／頁尾選單
const path = require('path');
const ejs = require('ejs');
const { db, all, get, run, tx, settings } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS content (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, meta_description TEXT,
  blocks TEXT NOT NULL DEFAULT '[]', published INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY, location TEXT NOT NULL, parent_id INTEGER REFERENCES menus(id) ON DELETE CASCADE,
  label TEXT NOT NULL, url TEXT NOT NULL DEFAULT '#', sequence INTEGER NOT NULL DEFAULT 0, new_tab INTEGER NOT NULL DEFAULT 0);
`);

// ---------------- HTML 清理（只保留安全的標籤與屬性） ----------------
const ALLOWED = {
  p: [], br: [], b: [], strong: [], i: [], em: [], u: [], s: [], span: [], div: [], small: [],
  h2: ['id'], h3: ['id'], h4: [], ul: [], ol: [], li: [], blockquote: [], hr: [],
  a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'],
  table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
  details: ['open'], summary: [], section: ['id'], nav: [], figure: [], figcaption: [],
};
const SAFE_URL = /^(https?:|mailto:|tel:|\/|#)/i;
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|form|textarea|select)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (m, tag, attrs) => {
      tag = tag.toLowerCase();
      if (!ALLOWED[tag]) return '';
      if (m.startsWith('</')) return `</${tag}>`;
      const keep = [];
      for (const [, name, , v1, v2, v3] of attrs.matchAll(/([a-zA-Z-]+)\s*(=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const n = name.toLowerCase();
        if (!ALLOWED[tag].includes(n) && n !== 'class') continue;
        if (n === 'class' && !/^[\w\s-]*$/.test(v1 ?? v2 ?? v3 ?? '')) continue;
        const v = (v1 ?? v2 ?? v3 ?? '').replace(/"/g, '&quot;');
        if ((n === 'href' || n === 'src') && !SAFE_URL.test(v.trim())) continue;
        keep.push(v === '' && n === 'open' ? 'open' : `${n}="${v}"`);
      }
      if (tag === 'a' && keep.some((k) => k.startsWith('target='))) keep.push('rel="noopener"');
      return `<${tag}${keep.length ? ' ' + keep.join(' ') : ''}>`;
    });
}
const safeUrl = (u, fallback = '#') => (SAFE_URL.test(String(u || '').trim()) ? String(u).trim() : fallback);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 內容中的 {{公司資料}} 代碼，換成「商店設定」裡的值
const NUMERIC = ['shipping_home', 'shipping_cvs', 'free_shipping_threshold'];
function renderTokens(html) {
  const s = settings();
  return String(html || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in s)) return m;
    const v = s[k];
    return esc(NUMERIC.includes(k) ? Number(v).toLocaleString('en-US') : v);
  });
}

// ---------------- 頁面內容（key → value） ----------------
let contentCache = null;
function content() {
  if (!contentCache) {
    contentCache = {};
    for (const r of all('SELECT key, value FROM content')) {
      try {
        contentCache[r.key] = JSON.parse(r.value);
      } catch {
        contentCache[r.key] = r.value;
      }
    }
  }
  return contentCache;
}
function saveContent(changes) {
  tx(() => {
    for (const [k, v] of Object.entries(changes)) {
      if (!/^[\w.:-]{1,120}$/.test(k)) continue;
      run(
        "INSERT INTO content (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')",
        k, JSON.stringify(cleanValue(v))
      );
    }
  });
  contentCache = null;
}
function resetContent(keys) {
  for (const k of keys) run('DELETE FROM content WHERE key = ?', k);
  contentCache = null;
}
function cleanValue(v) {
  if (v && typeof v === 'object' && 'href' in v) return { text: String(v.text || '').slice(0, 200), href: safeUrl(v.href), newTab: Boolean(v.newTab) };
  if (v && typeof v === 'object' && 'html' in v) return { html: sanitizeHtml(v.html) };
  return String(v ?? '').slice(0, 5000);
}

// 給樣板用的編輯工具：一般訪客只看到內容；編輯模式下多了 data-edit 屬性讓編輯器使用
function editor(editing, store = content(), prefix = '') {
  const val = (key, d) => (store[prefix + key] !== undefined && store[prefix + key] !== '' ? store[prefix + key] : d);
  const attr = (type, key) => (editing ? ` data-edit-${type}="${esc(prefix + key)}"` : '');
  // 版面區塊的顯示／刪除（存在 content 的 layout.hidden，內容是 JSON 陣列）
  const hiddenList = () => {
    try {
      const v = JSON.parse(content()['layout.hidden'] || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return {
    editing,
    hiddenList,
    show: (id) => !hiddenList().includes(id),
    bar: (id, label) => (editing ? `<div class="cms-secbar" data-section="${esc(id)}"><span>${esc(label)}</span><button type="button" data-section-op="hide" data-label="${esc(label)}">刪除區塊</button></div>` : ''),
    stub: (id, label) =>
      editing ? `<div class="container"><div class="cms-hidden-stub" data-section="${esc(id)}">已刪除：${esc(label)}（顧客看不到）<button type="button" data-section-op="show">復原</button></div></div>` : '',
    // 純文字（換行會保留）
    text(key, d, tag = 'span', cls = '') {
      const v = val(key, d);
      const t = esc(typeof v === 'string' ? v : d);
      // 編輯模式：顯示實際的值；點進去編輯時才顯示 {{代碼}}，避免代碼被覆蓋掉
      const raw = editing && t.includes('{{') ? ` data-raw="${t.replace(/\n/g, '&#10;')}"` : '';
      return `<${tag}${cls ? ` class="${cls}"` : ''}${attr('text', key)}${raw}>${renderTokens(t).replace(/\n/g, '<br>')}</${tag}>`;
    },
    raw(key, d) {
      const v = val(key, d);
      return typeof v === 'string' ? v : d;
    },
    // 圖文編輯器內容（允許粗體、連結、清單等）
    html(key, d, cls = '') {
      const v = val(key, null);
      const html = v && v.html !== undefined ? v.html : d;
      return `<div class="rich${cls ? ' ' + cls : ''}"${attr('html', key)}>${editing ? html : renderTokens(html)}</div>`;
    },
    // 按鈕／連結
    link(key, dText, dHref, cls = '', inner = null) {
      const v = val(key, null) || {};
      const text = v.text || dText;
      const href = v.href || dHref;
      const nt = v.newTab ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''}${nt}${attr('link', key)}>${inner ? inner(esc(text)) : esc(text)}</a>`;
    },
    href(key, dHref) {
      const v = val(key, null);
      return esc((v && v.href) || dHref);
    },
    // 圖片：回傳網址；imgAttr 加在 <img> 上
    src(key, d) {
      const v = val(key, d);
      return esc(typeof v === 'string' ? v : d);
    },
    imgAttr(key) {
      return attr('img', key);
    },
    bgAttr(key) {
      return attr('bg', key);
    },
  };
}

// 區塊用的編輯工具：把區塊資料攤平成 key，前綴為 pg:<頁面>:<序號>:
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix + k;
    if (v && typeof v === 'object' && !('href' in v) && !('html' in v)) flatten(v, key + '.', out);
    else out[key] = v;
  }
  return out;
}
function blockEditor(editing, pageId, index, data) {
  const prefix = `pg:${pageId}:${index}:`;
  return editor(editing, flatten(data, prefix), prefix);
}

// ---------------- 選單 ----------------
function menu(location) {
  const rows = all('SELECT * FROM menus WHERE location = ? ORDER BY sequence, id', location);
  const top = rows.filter((r) => !r.parent_id);
  for (const t of top) t.children = rows.filter((r) => r.parent_id === t.id);
  return top;
}
const MENU_LOCATIONS = {
  header: '頁首選單（分類列右側）',
  util: '頂部服務列',
  footer1: '頁尾「客戶服務」',
  footer2: '頁尾「購物說明」',
};
function seedMenus() {
  if (get('SELECT COUNT(*) AS n FROM menus').n) return;
  tx(() => {
    const add = (loc, label, url, seq, parent = null) => Number(run('INSERT INTO menus (location, parent_id, label, url, sequence) VALUES (?, ?, ?, ?, ?)', loc, parent, label, url, seq).lastInsertRowid);
    const g = add('header', '購物指南', '/shopping-guide', 1);
    add('header', '購物須知', '/shopping-guide', 1, g);
    add('header', '退換貨政策', '/return-policy', 2, g);
    add('header', '常見問題', '/fqa', 3, g);
    add('header', '關於我們', '/about-us', 2);
    add('util', '訂單查詢', '/order-lookup', 1);
    add('util', '常見問題', '/fqa', 2);
    add('util', '客服中心', '/contactus', 3);
    add('footer1', '訂單查詢', '/order-lookup', 1);
    add('footer1', '會員中心', '/my', 2);
    add('footer1', '聯絡我們', '/contactus', 3);
    add('footer1', '常見問題', '/fqa', 4);
    add('footer2', '購物須知', '/shopping-guide', 1);
    add('footer2', '退換貨政策', '/return-policy', 2);
    add('footer2', '關於我們', '/about-us', 3);
    add('footer2', '私隱政策', '/privacy', 4);
    add('footer2', '條款及條件', '/terms', 5);
  });
}

// ---------------- 頁面與區塊 ----------------
const SYS_SECTIONS = {
  promos: '首頁：促銷卡片',
  cats: '首頁：分類捷徑',
  popular: '首頁：最受歡迎的健康好物',
  explore: '首頁：探索健康生活好物',
  values: '首頁：以專業 守護健康生活',
  brands: '首頁：精選合作品牌',
};
const newSlide = () => ({ image: '/img/hero.jpg', title: '在這裡輸入標題', text: '在這裡輸入說明文字。', button: { text: '立即選購', href: '/shop' } });
const BLOCKS = {
  banner: { label: '主視覺／橫幅（可多張輪播）', data: () => ({ slides: [newSlide()] }) },
  sys: { label: '首頁內建區塊', data: () => ({ id: '' }) },
  pagehead: { label: '頁面標題列', data: () => ({ title: '頁面標題', text: '' }) },
  richtext: { label: '文字段落', data: () => ({ title: '段落標題', body: { html: '<p>在這裡輸入內容。點文字即可編輯，可使用粗體、清單和連結。</p>' } }) },
  imagetext: { label: '圖文並排', data: () => ({ image: '/img/03_caring-support.webp', title: '圖文標題', body: { html: '<p>在這裡輸入說明。</p>' }, button: { text: '了解更多', href: '/shop' }, reverse: false }) },
  cards: {
    label: '三欄卡片',
    data: () => ({
      title: '卡片區標題',
      items: [
        { image: '/img/01_professional-selection.webp', title: '卡片一', text: '卡片說明文字', link: { text: '查看', href: '/shop' } },
        { image: '/img/02_quality-assurance.webp', title: '卡片二', text: '卡片說明文字', link: { text: '查看', href: '/shop' } },
        { image: '/img/03_caring-support.webp', title: '卡片三', text: '卡片說明文字', link: { text: '查看', href: '/shop' } },
      ],
    }),
  },
  buttons: { label: '標語＋按鈕', data: () => ({ title: '標語文字', text: '補充說明', button: { text: '立即選購', href: '/shop' }, button2: { text: '聯絡我們', href: '/contactus' } }) },
  image: { label: '單張圖片', data: () => ({ image: '/img/hero.jpg', caption: '', link: { text: '', href: '' } }) },
  products: { label: '商品列', data: () => ({ title: '推薦商品', source: 'popular', count: 8 }) },
  faq: { label: '常見問答', data: () => ({ title: '常見問題', items: [{ q: '問題一？', a: '回答內容。' }, { q: '問題二？', a: '回答內容。' }] }) },
  html: { label: '自由內容（圖文編輯器）', data: () => ({ html: { html: '<p>在這裡輸入內容。</p>' } }) },
};

function parseBlocks(json) {
  try {
    const b = JSON.parse(json || '[]');
    return Array.isArray(b) ? b.filter((x) => x && BLOCKS[x.type]) : [];
  } catch {
    return [];
  }
}
function getPage(slug, includeDraft = false) {
  const p = get(`SELECT * FROM pages WHERE slug = ?${includeDraft ? '' : ' AND published = 1'}`, slug);
  if (p) p.blocks = parseBlocks(p.blocks);
  return p || null;
}
function getPageById(id) {
  const p = get('SELECT * FROM pages WHERE id = ?', Number(id));
  if (p) p.blocks = parseBlocks(p.blocks);
  return p || null;
}
function listPages() {
  return all('SELECT id, slug, title, meta_description, published, system, updated_at FROM pages ORDER BY system DESC, id');
}
function savePageBlocks(id, blocks) {
  run("UPDATE pages SET blocks = ?, updated_at = datetime('now','localtime') WHERE id = ?", JSON.stringify(blocks), id);
}

// 依 'items.0.title' 這種路徑寫入值
function setPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (o[k] === undefined || o[k] === null || typeof o[k] !== 'object') return false;
    o = o[k];
  }
  const last = /^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1);
  if (['__proto__', 'constructor', 'prototype'].includes(String(last))) return false;
  o[last] = value;
  return true;
}
// 套用編輯器送來的區塊內容變更：key 格式為 "pg:<頁面ID>:<區塊序號>:<欄位路徑>"
function applyBlockChanges(changes) {
  const byPage = {};
  for (const [k, v] of Object.entries(changes)) {
    const m = /^pg:(\d+):(\d+):([\w.]+)$/.exec(k);
    if (m) (byPage[m[1]] ||= []).push([Number(m[2]), m[3], cleanValue(v)]);
  }
  for (const [pid, list] of Object.entries(byPage)) {
    const p = getPageById(pid);
    if (!p) continue;
    for (const [i, field, v] of list) if (p.blocks[i]) setPath(p.blocks[i].data, field, v);
    savePageBlocks(p.id, p.blocks);
  }
  return Object.keys(byPage).length;
}

function blockOp(pageId, { op, at, type, to, field }) {
  const p = getPageById(pageId);
  if (!p) throw new Error('找不到頁面');
  const b = p.blocks;
  at = Number(at);
  if (op === 'add') {
    const pos = Math.max(0, Math.min(b.length, Number.isFinite(at) ? at : b.length));
    if (String(type).startsWith('sys:')) {
      const id = type.slice(4);
      if (!SYS_SECTIONS[id]) throw new Error('不支援的區塊類型');
      if (b.some((x) => x.type === 'sys' && x.data.id === id)) throw new Error('這個內建區塊已經在頁面上了');
      b.splice(pos, 0, { type: 'sys', data: { id } });
    } else {
      if (!BLOCKS[type] || type === 'sys') throw new Error('不支援的區塊類型');
      b.splice(pos, 0, { type, data: BLOCKS[type].data() });
    }
  } else if (op === 'delete') b.splice(at, 1);
  else if (op === 'move') {
    const t = Number(to);
    if (b[at] && t >= 0 && t < b.length) b.splice(t, 0, b.splice(at, 1)[0]);
  } else if (op === 'duplicate') {
    if (b[at] && b[at].type !== 'sys') b.splice(at + 1, 0, JSON.parse(JSON.stringify(b[at])));
  } else if (op === 'add-slide' && b[at] && b[at].type === 'banner') {
    let d = b[at].data;
    if (!Array.isArray(d.slides)) b[at].data = d = { slides: [{ image: d.image, title: d.title, text: d.text, button: d.button }] };
    const last = d.slides[d.slides.length - 1] || newSlide();
    d.slides.push({ ...JSON.parse(JSON.stringify(last)), image: '/img/hero.jpg' });
  } else if (op === 'remove-slide' && b[at] && b[at].type === 'banner' && Array.isArray(b[at].data.slides)) {
    if (b[at].data.slides.length <= 1) throw new Error('至少要保留一張圖片；要整個移除請按「刪除區塊」');
    b[at].data.slides.splice(Number(to), 1);
  } else if (op === 'toggle' && b[at] && field === 'reverse') b[at].data.reverse = !b[at].data.reverse;
  else if (op === 'set' && b[at] && ['source', 'count'].includes(field)) b[at].data[field] = field === 'count' ? Math.max(1, Math.min(20, Number(to) || 8)) : String(to);
  else if (op === 'add-item' && b[at] && Array.isArray(b[at].data.items)) {
    const proto = b[at].type === 'faq' ? { q: '新問題？', a: '回答內容。' } : { image: '/img/04_diverse-choices.webp', title: '新卡片', text: '卡片說明文字', link: { text: '查看', href: '/shop' } };
    b[at].data.items.push(proto);
  } else if (op === 'remove-item' && b[at] && Array.isArray(b[at].data.items)) b[at].data.items.splice(Number(to), 1);
  else throw new Error('無效的操作');
  savePageBlocks(p.id, b);
}

// ---------------- 把原本寫死的說明頁轉成可編輯頁面 ----------------
const BUILTIN = { 'about-us': '關於我們', fqa: '常見問題', 'return-policy': '退換貨政策', 'shopping-guide': '購物須知', terms: '條款及條件', privacy: '私隱政策' };
function seedBuiltinPages(viewsDir) {
  const S = settings();
  const tokenSettings = Object.fromEntries(Object.keys(S).map((k) => [k, `{{${k}}}`]));
  for (const [slug, title] of Object.entries(BUILTIN)) {
    if (get('SELECT id FROM pages WHERE slug = ?', slug)) continue;
    const file = path.join(viewsDir, 'pages', slug + '.ejs');
    let html;
    try {
      html = ejs.render(require('fs').readFileSync(file, 'utf8').replace(/<%-\s*include\([^)]*\)\s*%>/g, ''), {
        title, settings: tokenSettings, money: (v) => 'NT$ ' + v, freeShip: '{{free_shipping_threshold}}',
        ship: { home: { fee: '{{shipping_home}}' }, cvs: { fee: '{{shipping_cvs}}' } },
      }, { filename: file });
    } catch (e) {
      console.error('轉換頁面失敗', slug, e.message);
      continue;
    }
    const heroM = /<section class="page-hero">\s*<div class="container">([\s\S]*?)<\/div>\s*<\/section>/.exec(html);
    const h1 = heroM ? (/<h1>([\s\S]*?)<\/h1>/.exec(heroM[1]) || [])[1] : title;
    const sub = heroM ? (/<p>([\s\S]*?)<\/p>/.exec(heroM[1]) || [])[1] || '' : '';
    const bodyM = /<div class="container page doc">([\s\S]*)<\/div>\s*$/.exec(html.trim());
    const body = bodyM ? bodyM[1] : html.replace(/<section class="page-hero">[\s\S]*?<\/section>/, '');
    const blocks = [
      { type: 'pagehead', data: { title: (h1 || title).trim(), text: sub.replace(/<[^>]+>/g, '').trim() } },
      { type: 'html', data: { html: { html: sanitizeHtml(body.trim()) } } },
    ];
    run('INSERT INTO pages (slug, title, blocks, system) VALUES (?, ?, ?, 1)', slug, title, JSON.stringify(blocks));
  }
}

function migrateHome() {
  if (content()['home.layout_v2']) return;
  const c = content();
  let hidden = [];
  try {
    hidden = JSON.parse(c['layout.hidden'] || '[]');
  } catch {}
  const home = getPage('home', true);
  const custom = home ? home.blocks : [];
  const blocks = [];
  if (!hidden.includes('hero')) {
    blocks.push({
      type: 'banner',
      data: {
        slides: [{
          image: c['home.hero.image'] || '/img/hero.jpg',
          title: c['home.hero.title'] || '讓健康，成為生活的日常',
          text: c['home.hero.text'] || '從日常照護到居家保健，我們嚴選實用、安心的健康用品。\n不論是自己使用，還是照顧家中長輩，都能在這裡找到最合適的選擇。',
          button: c['home.hero.button'] || { text: '立即選購', href: '/shop' },
        }],
      },
    });
  }
  for (const id of ['promos', 'cats', 'popular', 'explore', 'values']) if (!hidden.includes(id)) blocks.push({ type: 'sys', data: { id } });
  blocks.push(...custom);
  if (!hidden.includes('brands')) blocks.push({ type: 'sys', data: { id: 'brands' } });
  run("UPDATE pages SET blocks = ?, title = '首頁' WHERE slug = 'home'", JSON.stringify(blocks));
  saveContent({ 'home.layout_v2': '1', 'layout.hidden': JSON.stringify(hidden.filter((h) => h === 'service')) });
}

function init(viewsDir) {
  if (!get("SELECT id FROM pages WHERE slug = 'home'")) run("INSERT INTO pages (slug, title, blocks, system) VALUES ('home', '首頁', '[]', 1)");
  migrateHome();
  seedMenus();
  seedBuiltinPages(viewsDir);
}

module.exports = {
  BLOCKS, SYS_SECTIONS, MENU_LOCATIONS, BUILTIN,
  content, saveContent, resetContent, editor, blockEditor, renderTokens, sanitizeHtml, safeUrl, esc,
  menu, getPage, getPageById, listPages, savePageBlocks, applyBlockChanges, blockOp, init,
};
