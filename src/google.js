// Google 試算表匯入：支援「API 金鑰」（公開試算表）或「服務帳戶」（私人試算表）
const crypto = require('crypto');

const SHEETS = process.env.GOOGLE_SHEETS_BASE || 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function parseSheetUrl(url) {
  const s = String(url || '').trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s);
  const id = m ? m[1] : /^[a-zA-Z0-9-_]{25,}$/.test(s) ? s : null;
  const gid = /[#&?]gid=(\d+)/.exec(s)?.[1] ?? null;
  return { id, gid };
}

// ---- 服務帳戶：自己簽 JWT 換 access token（不需要安裝 googleapis 套件） ----
let tokenCache = { key: null, token: null, exp: 0 };
async function serviceAccountToken(json) {
  let sa;
  try {
    sa = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('服務帳戶金鑰不是有效的 JSON，請貼上下載的 .json 檔完整內容');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('服務帳戶金鑰缺少 client_email 或 private_key');
  if (tokenCache.key === sa.client_email && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google 服務帳戶驗證失敗：' + (data.error_description || data.error || res.status));
  tokenCache = { key: sa.client_email, token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function googleGet(url, { apiKey, serviceAccount }) {
  const headers = {};
  const u = new URL(url);
  if (serviceAccount) headers.Authorization = 'Bearer ' + (await serviceAccountToken(serviceAccount));
  else if (apiKey) u.searchParams.set('key', apiKey);
  else throw new Error('尚未設定 Google API 金鑰或服務帳戶（請到「設定 → Google 匯入」填寫）');
  const res = await fetch(u, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `無法讀取試算表（${msg}）。` +
          (serviceAccount ? '請確認已把試算表「共用」給服務帳戶的 Email。' : '使用 API 金鑰時，試算表需設為「知道連結的任何人都可以檢視」。')
      );
    }
    throw new Error('Google API 錯誤：' + msg);
  }
  return data;
}

// 讀取試算表的值（二維陣列）
async function fetchSheet({ sheetUrl, range, apiKey, serviceAccount }) {
  const { id, gid } = parseSheetUrl(sheetUrl);
  if (!id) throw new Error('試算表網址格式不正確，請貼上瀏覽器網址列的完整網址');
  const auth = { apiKey, serviceAccount };
  let r = String(range || '').trim();
  if (!r) {
    // 沒指定範圍：用網址裡的分頁（gid），否則用第一個分頁
    const meta = await googleGet(`${SHEETS}/${id}?fields=properties.title,sheets.properties(sheetId,title)`, auth);
    const sheet = (gid != null && meta.sheets.find((s) => String(s.properties.sheetId) === gid)) || meta.sheets[0];
    r = `'${sheet.properties.title.replace(/'/g, "''")}'`;
  }
  const data = await googleGet(`${SHEETS}/${id}/values/${encodeURIComponent(r)}?valueRenderOption=FORMATTED_VALUE`, auth);
  return data.values || [];
}

// ---- 簡易 CSV 解析（支援引號、換行） ----
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') cell += '"', i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

// ---- 欄位對應 ----
const COLUMNS = {
  sku: ['sku', '貨號', '商品編號', '料號', '編號'],
  name: ['name', '名稱', '商品名稱', '品名'],
  price: ['price', '價格', '售價'],
  compare_price: ['compare_price', '原價', '定價', '市價'],
  cost: ['cost', '成本'],
  stock: ['stock', '庫存', '數量', '庫存數量'],
  categories: ['category', 'categories', '分類', '商品分類'],
  brand: ['brand', '品牌'],
  description: ['description', '簡介', '說明', '商品說明', '描述'],
  images: ['image', 'images', '圖片', '圖片網址', '圖片連結'],
  license_no: ['license', 'license_no', '許可證字號', '許可證'],
  published: ['published', '上架', '是否上架'],
  featured: ['featured', '熱門', '精選'],
  sequence: ['sequence', '排序'],
  license_holder: ['license_holder', '許可證所有人'],
  manufacturer: ['manufacturer', '製造業者', '製造商'],
  origin: ['origin', '產地'],
  spec: ['spec', '規格'],
  precautions: ['precautions', '注意事項', '使用注意事項', '警語'],
};
const TEMPLATE_HEADER = ['貨號', '名稱', '價格', '原價', '庫存', '分類', '品牌', '簡介', '圖片網址', '許可證字號', '上架', '熱門', '排序', '許可證所有人', '製造業者', '產地', '規格', '注意事項'];

function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    for (const [field, aliases] of Object.entries(COLUMNS)) if (aliases.includes(key) && map[field] == null) map[field] = i;
  });
  return map;
}

const num = (v) => {
  const s = String(v ?? '').replace(/NT\$|\$|元|,|\s/gi, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
const bool = (v, dflt) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return dflt;
  if (['是', 'y', 'yes', 'true', '1', 'v', '✓', '✔', 'o', '上架'].includes(s)) return 1;
  if (['否', 'n', 'no', 'false', '0', 'x', '下架'].includes(s)) return 0;
  return dflt;
};
const splitList = (v) =>
  String(v ?? '')
    .split(/[、,，;；\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);

// Google 雲端硬碟分享連結 → 可直接顯示的圖片網址
function normalizeImageUrl(u) {
  const s = u.trim();
  const m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return `https://lh3.googleusercontent.com/d/${m[1]}`;
  return s;
}

// 把試算表的列轉成商品資料，並驗證
function rowsToProducts(rows) {
  if (!rows.length) throw new Error('試算表是空的');
  const header = rows[0];
  const map = mapHeader(header);
  if (map.name == null) throw new Error(`找不到「名稱」欄位。第一列必須是標題列，可用的欄位：${TEMPLATE_HEADER.join('、')}`);
  if (map.price == null) throw new Error('找不到「價格」欄位');
  const col = (r, f) => (map[f] == null ? undefined : r[map[f]]);
  return rows.slice(1).map((r, i) => {
    const errors = [];
    const name = String(col(r, 'name') ?? '').trim();
    const price = num(col(r, 'price'));
    if (!name) errors.push('缺少名稱');
    if (price == null || Number.isNaN(price) || price < 0) errors.push('價格不正確');
    const stock = num(col(r, 'stock'));
    if (Number.isNaN(stock)) errors.push('庫存不是數字');
    const compare = num(col(r, 'compare_price'));
    const seq = num(col(r, 'sequence'));
    const has = (f) => map[f] != null && String(col(r, f) ?? '').trim() !== '';
    return {
      row: i + 2,
      errors,
      sku: String(col(r, 'sku') ?? '').trim() || null,
      name,
      price,
      compare_price: Number.isNaN(compare) ? null : compare,
      cost: has('cost') ? num(col(r, 'cost')) : undefined,
      stock: stock == null || Number.isNaN(stock) ? undefined : Math.floor(stock),
      categories: has('categories') ? splitList(col(r, 'categories')) : undefined,
      brand: has('brand') ? String(col(r, 'brand')).trim() : undefined,
      description: has('description') ? String(col(r, 'description')).trim() : undefined,
      images: has('images') ? splitList(String(col(r, 'images')).replace(/\s+(?=https?:)/g, '\n')).map(normalizeImageUrl) : undefined,
      license_no: has('license_no') ? String(col(r, 'license_no')).trim() : undefined,
      license_holder: has('license_holder') ? String(col(r, 'license_holder')).trim() : undefined,
      manufacturer: has('manufacturer') ? String(col(r, 'manufacturer')).trim() : undefined,
      origin: has('origin') ? String(col(r, 'origin')).trim() : undefined,
      spec: has('spec') ? String(col(r, 'spec')).trim() : undefined,
      precautions: has('precautions') ? String(col(r, 'precautions')).trim() : undefined,
      published: bool(col(r, 'published'), 1),
      featured: map.featured != null ? bool(col(r, 'featured'), 0) : undefined,
      sequence: seq == null || Number.isNaN(seq) ? undefined : seq,
    };
  });
}

module.exports = { parseSheetUrl, fetchSheet, parseCsv, toCsv, rowsToProducts, TEMPLATE_HEADER, normalizeImageUrl };
