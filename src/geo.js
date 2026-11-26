// GEO（生成式引擎優化）／AEO（答案引擎優化）／AIO（AI 摘要優化）
// 讓 ChatGPT、Gemini、Google AI 摘要、Perplexity 等 AI 搜尋更容易讀懂、引用本站內容。
// 全部以規則產生（不需要外部 AI 服務），只補空白欄位，不覆蓋人工寫的內容。
const { db, all, get, run, tx, settings } = require('./db');

function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('products', 'meta_description', 'TEXT');
addColumn('products', 'summary', 'TEXT');
addColumn('products', 'faq', 'TEXT');
addColumn('categories', 'seo_intro', 'TEXT');
for (const [k, v] of Object.entries({ ai_crawlers: 'allow', geo_auto: '1', llms_summary: '' })) db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
{
  const old = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key IN ('ai_crawlers','geo_auto')").all().map((r) => [r.key, r.value]));
  for (const [k, v] of Object.entries({
    // GEO
    geo_bots_answer: old.ai_crawlers || 'allow', // 回答用爬蟲（AI 回答問題時來讀網頁）
    geo_bots_train: old.ai_crawlers || 'allow', // 訓練用爬蟲（拿去訓練模型）
    geo_llms: '1',
    // AEO
    aeo_show_summary: '1',
    aeo_show_faq: '1',
    aeo_faq_ld: '1',
    aeo_faq_max: '6',
    aeo_auto: old.geo_auto || '1',
    // AIO
    aio_ld: '1',
    aio_meta_len: '150',
    aio_auto: old.geo_auto || '1',
  })) db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}
require('./db').saveSettings({}); // 新增預設值後，清掉設定快取

// AI 爬蟲分兩種：回答用（AI 回答問題、搜尋時來讀網頁，和被引用直接相關）／訓練用（收集資料訓練模型）
const ANSWER_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'DuckAssistBot', 'MistralAI-User'];
const TRAIN_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'meta-externalagent', 'Amazonbot', 'cohere-ai'];
const AI_BOTS = [...ANSWER_BOTS, ...TRAIN_BOTS];
const num = (k, d) => Number(settings()[k]) || d;

const placeholder = (v) => !v || /【.*】/.test(String(v));
const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\{\{\w+\}\}/g, '').replace(/\s+/g, ' ').trim();
const money = (n) => 'NT$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const sentences = (t) => strip(t).split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
function clip(text, max = 150) {
  const t = strip(text);
  if (t.length <= max) return t;
  let out = '';
  for (const s of sentences(t)) {
    if ((out + s).length > max) break;
    out += s;
  }
  // 句子太長、切完剩太少時，直接截斷到上限
  return out.length >= max * 0.45 ? out : t.slice(0, max - 1) + '…';
}
const parseFaq = (v) => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a.filter((x) => x && x.q && x.a) : [];
  } catch {
    return [];
  }
};
// 後台輸入格式：「Q: 問題」下一行「A: 回答」
function faqFromText(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(Q|問)[:：]\s*(.+)$/i.exec(line);
    const n = /^\s*(A|答)[:：]\s*(.+)$/i.exec(line);
    if (m) (cur = { q: m[2].trim(), a: '' }), out.push(cur);
    else if (n && cur) cur.a = (cur.a ? cur.a + '\n' : '') + n[2].trim();
    else if (cur && line.trim()) cur.a += (cur.a ? '\n' : '') + line.trim();
  }
  return out.filter((x) => x.q && x.a);
}
const faqToText = (list) => list.map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n\n');

// ---------- 產生內容 ----------
function productContext(p) {
  const cats = all('SELECT c.name FROM categories c JOIN product_categories pc ON pc.category_id = c.id WHERE pc.product_id = ?', p.id).map((r) => r.name);
  const brand = p.brand_id ? (get('SELECT name FROM brands WHERE id = ?', p.brand_id) || {}).name : '';
  const spec = String(p.spec || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { cats, brand, spec };
}
function genProductMeta(p) {
  const s = settings();
  const { cats, brand } = productContext(p);
  const lead = clip(p.description, 80);
  const base = `${p.name}${brand ? `（${brand}）` : ''}${cats.length ? `｜${cats[0]}` : ''}。${lead}`;
  const tail = ` 售價 ${money(p.price)}，滿 ${money(s.free_shipping_threshold)} 免運${p.license_no ? '，衛福部醫療器材許可證可查詢' : ''}。`;
  return clip(base + tail, num('aio_meta_len', 150));
}
function genProductSummary(p) {
  const s = settings();
  const { cats, brand, spec } = productContext(p);
  const first = sentences(p.description)[0];
  const lines = [];
  if (first) lines.push(first.replace(/[。！？]$/, ''));
  const suit = sentences(p.description).find((x) => /適合|適用/.test(x));
  if (suit && suit !== first) lines.push(suit.replace(/[。！？]$/, ''));
  if (spec.length) lines.push(spec.slice(0, 2).join('；'));
  if (brand || cats.length) lines.push([brand && `品牌：${brand}`, cats.length && `分類：${cats.join('、')}`].filter(Boolean).join('｜'));
  if (p.license_no) lines.push(`醫療器材許可證字號：${p.license_no}`);
  lines.push(`售價 ${money(p.price)}，單筆滿 ${money(s.free_shipping_threshold)} 免運，付款後 ${s.ship_days} 個工作天出貨`);
  return lines.slice(0, 5).join('\n');
}
function genProductFaq(p) {
  const s = settings();
  const { spec } = productContext(p);
  const suit = sentences(p.description).find((x) => /適合|適用/.test(x));
  const faq = [];
  if (suit) faq.push({ q: `${p.name}適合哪些人使用？`, a: suit });
  faq.push({ q: `${p.name}多少錢？有免運嗎？`, a: `售價 ${money(p.price)}。全館單筆滿 ${money(s.free_shipping_threshold)} 免運，未滿額宅配運費 ${money(s.shipping_home)}、超商取貨 ${money(s.shipping_cvs)}。` });
  if (p.license_no) faq.push({ q: `${p.name}是合法的醫療器材嗎？`, a: `是。本商品領有衛生福利部醫療器材許可證，字號為「${p.license_no}」，可至食藥署醫療器材許可證查詢系統核對。使用前請詳閱說明書及注意事項。` });
  if (spec.length) faq.push({ q: `${p.name}的規格與材質是什麼？`, a: spec.join('；') + '。' });
  if (p.size_chart) faq.push({ q: `${p.name}要怎麼選尺寸？`, a: '請參考商品頁的「尺寸對照表」，依表中標示的位置量測周長。若剛好介於兩個尺碼之間，歡迎聯絡客服協助選擇。' });
  faq.push({ q: '下單後多久會出貨？', a: `付款完成後 ${s.ship_days} 個工作天內出貨（不含例假日），宅配一般出貨後 ${s.delivery_days} 天送達。` });
  faq.push({ q: '可以退換貨嗎？', a: '商品到貨後享 7 天鑑賞期，未拆封、未使用且包裝完整的商品可申請退換；已拆封的個人衛生用品依法不適用。詳細請見退換貨政策。' });
  return faq.slice(0, num('aeo_faq_max', 6));
}
function genCategoryIntro(c) {
  const prods = all('SELECT p.name FROM products p JOIN product_categories pc ON pc.product_id = p.id WHERE pc.category_id = ? AND p.published = 1 ORDER BY p.sold_count DESC, p.sequence LIMIT 4', c.id).map((r) => r.name);
  const n = get('SELECT COUNT(*) AS n FROM product_categories pc JOIN products p ON p.id = pc.product_id AND p.published = 1 WHERE pc.category_id = ?', c.id).n;
  const desc = c.description ? `，主要提供${c.description.replace(/[。]$/, '')}的相關用品` : '';
  return `${c.name}${desc}。目前共有 ${n} 項商品${prods.length ? `，熱門商品包括${prods.join('、')}` : ''}。醫療器材類商品皆標示衛福部許可證字號，單筆滿 ${money(settings().free_shipping_threshold)} 免運。`;
}
function genPageMeta(page) {
  const s = settings();
  // 先把 {{代碼}} 換成商店資料；公司名稱尚未填寫時用商店名稱
  const tok = (t) => String(t || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (placeholder(s[k]) ? (k === 'company_name' ? s.store_name : '') : s[k] || ''));
  // 去掉目錄（nav）和小標題，只留內文段落
  const body = (html) => tok(html).replace(/<nav[\s\S]*?<\/nav>/g, ' ').replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/g, ' ').replace(/<summary[^>]*>([\s\S]*?)<\/summary>/g, '$1？').replace(/<\/(p|li|td|details)>/g, '。');
  const head = page.blocks.find((b) => b.type === 'pagehead');
  const texts = [head && tok(head.data.text)];
  for (const b of page.blocks) {
    if (b.type === 'html') texts.push(body(b.data.html && b.data.html.html));
    if (b.type === 'richtext') texts.push(body(b.data.body && b.data.body.html));
    if (b.type === 'banner') texts.push(...(b.data.slides || [b.data]).map((x) => `${tok(x.title)}。${tok(x.text)}`));
    if (b.type === 'imagetext') texts.push(tok(b.data.title) + '。' + body(b.data.body && b.data.body.html));
    if (b.type === 'faq') texts.push((b.data.items || []).map((x) => tok(x.q) + '？' + tok(x.a)).join(''));
  }
  const t = texts.filter(Boolean).map(strip).join('').replace(/【[^】]*】[。]?/g, '').replace(/成立於[，,]/g, '').replace(/。{2,}/g, '。').replace(/？{2,}/g, '？').replace(/^。/, '');
  return clip(`${page.title}｜${s.store_name}。${t}`, num('aio_meta_len', 150));
}
function siteSummary() {
  const s = settings();
  if (s.llms_summary && s.llms_summary.trim()) return s.llms_summary.trim();
  const cats = all('SELECT name FROM categories WHERE published = 1 AND parent_id IS NULL ORDER BY sequence').map((r) => r.name);
  return `${s.store_name}是台灣的健康照護與居家保健用品網路商店，提供${cats.join('、')}等商品。醫療器材類商品皆領有衛生福利部醫療器材許可證；單筆滿 ${money(s.free_shipping_threshold)} 免運，到貨享 7 天鑑賞期。`;
}

// ---------- 健檢 ----------
const pageUrl = (p) => (p.slug === 'home' ? '/' : p.system ? '/' + p.slug : '/p/' + p.slug);
const prodUrl = (p) => `/shop/${encodeURIComponent(p.name.replace(/[\s/?#]+/g, '-').toLowerCase())}-${p.id}`;
// 三類的說明（後台「AI 搜尋優化」各頁顯示）
const CATS = {
  geo: {
    name: 'GEO', full: '生成式引擎優化', en: 'Generative Engine Optimization',
    goal: '讓 ChatGPT、Perplexity、Claude、Gemini 在回答問題時引用並推薦你的商品',
    short: '讓聊天型 AI 回答時推薦你',
    what: '越來越多人不再用 Google 一頁頁找，而是直接問 ChatGPT 這類 AI：「推薦一個護膝」。AI 會先上網找資料，整理成一段回答，並在旁邊附上參考來源。GEO 就是讓你的網站成為 AI 找得到、看得懂、願意引用的來源。',
    where: ['ChatGPT（含 ChatGPT 搜尋）', 'Perplexity', 'Claude', 'Google Gemini', 'Microsoft Copilot'],
    example: { q: '顧客問 ChatGPT：「久坐腰痠，有推薦的護腰嗎？」', a: 'ChatGPT 回答時列出幾款護腰，其中提到「康伴的拉繩式量子訊息護腰，可依腰圍調整鬆緊…」，並附上你商品頁的連結。' },
    done: ['允許 AI 回答用爬蟲來讀網站（robots.txt）', '商品頁清楚列出規格、許可證字號、價格與出貨資訊', '分類頁有介紹段落，讓 AI 知道這類商品是什麼', '提供 llms.txt 網站摘要（目前效果很小）'],
    todo: ['商品說明寫具體：用途、適合誰、材質、尺寸，避免空泛的形容詞', '補齊公司名稱、地址、電話、藥商執照，AI 會依此判斷可信度', '讓其他網站提到你：部落客開箱、新聞、PTT、Dcard、電商評價，這是影響最大的因素'],
  },
  aeo: {
    name: 'AEO', full: '答案引擎優化', en: 'Answer Engine Optimization',
    goal: '用重點摘要與問答，讓搜尋和語音助理直接把你的內容當成答案',
    short: '讓你的內容直接被當成答案',
    what: '很多搜尋不是要看一堆網頁，而是想要「一句話的答案」，例如「護膝要怎麼選尺寸？」。搜尋引擎、語音助理和 AI 會優先採用寫成「一問一答」、或用條列整理好重點的內容。AEO 就是把你的內容整理成這種好被直接拿去回答的格式。',
    where: ['Google 搜尋結果最上方的精選答案', 'Google 的「其他人也問了」', 'Siri、Google 助理等語音助理', 'AI 回答中引用的問答段落'],
    example: { q: '顧客搜尋：「護膝尺寸怎麼量？」', a: '搜尋結果直接顯示你商品頁「常見問答」裡的那段回答：「請參考尺寸對照表，依膝上 10 公分處量測周長…」，點進來就是你的商品。' },
    done: ['商品頁價格下方的「重點摘要」條列', '商品頁的「常見問答」分頁', '問答結構化資料（FAQPage），讓機器知道哪段是問題、哪段是答案', '「常見問題」頁的問答'],
    todo: ['把顧客常問客服的問題寫進商品問答（尺寸、怎麼用、多久出貨、能不能退）', '回答開頭就直接給答案，再補充說明', '重點摘要每點一句話、具體有數字'],
  },
  aio: {
    name: 'AIO', full: 'AI 摘要優化', en: 'AI Overviews Optimization',
    goal: '讓 Google 搜尋上方的「AI 摘要」正確理解並引用你的頁面',
    short: '讓 Google「AI 摘要」引用你',
    what: '現在用 Google 搜尋時，結果最上方常會出現一段由 AI 寫的「AI 摘要」，下方附上參考的網站。Google 主要從搜尋排名前面的網頁挑選來源，所以 AIO 基本上就是把一般的搜尋優化做好：每頁有清楚的標題與描述、內容充實、Google 讀得懂商品資訊。',
    where: ['Google 搜尋結果最上方的「AI 摘要」', 'Google 的「AI 模式」'],
    example: { q: '顧客在 Google 搜尋：「睡不好 助眠產品推薦」', a: '最上方的 AI 摘要整理了幾種助眠用品，旁邊的參考來源中有你的「睡眠OK繃助眠貼片禮盒」頁面。' },
    done: ['每個商品與頁面的搜尋描述', '商品、麵包屑、商品清單、網站搜尋等結構化資料，讓 Google 讀懂價格、庫存、分類', 'sitemap.xml（網站地圖，含更新日期），讓 Google 知道有哪些頁面'],
    todo: ['網站上線後，到 Google Search Console 提交網站地圖，確認頁面有被收錄', '頁面內容要充實，不要只有一兩句', '經營品牌口碑，讓搜尋排名往前'],
  },
};
function audit() {
  const s = settings();
  const out = {};
  for (const c of Object.keys(CATS)) out[c] = { items: [], site: [] };
  const push = (cat, base, checks) => {
    if (!checks.length) return;
    const total = checks.reduce((a, c) => a + c.w, 0);
    const got = checks.filter((c) => c.ok).reduce((a, c) => a + c.w, 0);
    out[cat].items.push({ ...base, score: Math.round((got / total) * 100), issues: checks.filter((c) => !c.ok).map((c) => c.msg), auto: checks.filter((c) => !c.ok && c.auto).length });
  };
  const metaCheck = (v, w) => ({ w, ok: (v || '').length >= 50, msg: (v || '').trim() ? '搜尋描述太短（建議 70 字以上）' : '缺少搜尋描述', auto: !(v || '').trim() });

  for (const p of all('SELECT * FROM products WHERE published = 1 ORDER BY sequence, id')) {
    const base = { type: '商品', name: p.name, url: prodUrl(p), edit: '/admin/products/' + p.id + '#geo' };
    const faq = parseFaq(p.faq);
    const imgs = JSON.parse(p.images || '[]');
    push('geo', base, [
      { w: 2, ok: strip(p.description).length >= 60, msg: '商品說明太短（建議 60 字以上，寫清楚用途、適合對象）' },
      { w: 1, ok: !!(p.spec || '').trim(), msg: '缺少規格（材質、尺寸、內容量等具體資訊）' },
      { w: 2, ok: !p.is_medical || !!p.license_no, msg: '醫療器材缺少許可證字號' },
      { w: 1, ok: !!get('SELECT 1 FROM product_categories WHERE product_id = ?', p.id), msg: '沒有分類' },
    ]);
    push('aeo', base, [
      { w: 3, ok: !!(p.summary || '').trim(), msg: '缺少重點摘要', auto: true },
      { w: 3, ok: faq.length >= 3, msg: '常見問答少於 3 題', auto: true },
    ]);
    push('aio', base, [metaCheck(p.meta_description, 3), { w: 1, ok: !!(p.image || imgs.length), msg: '缺少商品圖片' }]);
  }
  for (const c of all('SELECT * FROM categories WHERE published = 1 ORDER BY sequence, id')) {
    const base = { type: '分類', name: c.name, url: `/shop/category/${encodeURIComponent(c.name)}-${c.id}`, edit: '/admin/categories?edit=' + c.id };
    push('geo', base, [
      { w: 1, ok: !!(c.description || '').trim(), msg: '缺少分類說明' },
      { w: 2, ok: (c.seo_intro || '').length >= 40, msg: (c.seo_intro || '').trim() ? '分類介紹太短（建議 40 字以上）' : '缺少分類介紹段落', auto: !(c.seo_intro || '').trim() },
    ]);
  }
  let faqPageQs = 0;
  for (const pg of all("SELECT * FROM pages WHERE published = 1 AND slug != 'home'")) {
    let blocks = [];
    try {
      blocks = JSON.parse(pg.blocks);
    } catch {}
    const base = { type: '頁面', name: pg.title, url: pageUrl(pg), edit: '/admin/pages' };
    const text = blocks.map((b) => strip(JSON.stringify(b.data))).join(' ');
    push('aio', base, [
      metaCheck(pg.meta_description, 2),
      { w: 1, ok: blocks.some((b) => b.type === 'pagehead' || b.type === 'banner'), msg: '缺少頁面標題區塊' },
      { w: 1, ok: text.length >= 200, msg: '內容太少（建議 200 字以上）' },
    ]);
    faqPageQs += faqFromBlocks(blocks).length;
  }
  const answerOk = s.geo_bots_answer !== 'block';
  out.geo.site = [
    { ok: answerOk, msg: '允許 AI 回答用爬蟲讀取網站（被引用的前提）', fix: '下方設定「回答用爬蟲」選允許' },
    { ok: !placeholder(s.company_name), msg: '公司全名已填寫（AI 判斷可信度）', fix: '商店設定 → 公司全名' },
    { ok: !placeholder(s.phone) && !placeholder(s.address), msg: '電話與地址已填寫', fix: '商店設定 → 客服電話、公司地址' },
    { ok: !placeholder(s.license_no), msg: '藥商許可執照字號已填寫', fix: '商店設定 → 藥商許可執照字號' },
  ];
  out.aeo.site = [
    { ok: s.aeo_show_summary === '1', msg: '商品頁顯示重點摘要', fix: '下方設定開啟' },
    { ok: s.aeo_show_faq === '1', msg: '商品頁顯示常見問答', fix: '下方設定開啟' },
    { ok: s.aeo_faq_ld === '1', msg: '輸出問答結構化資料（FAQPage）', fix: '下方設定開啟' },
    { ok: faqPageQs >= 3, msg: `網站頁面中的問答（目前 ${faqPageQs} 題）`, fix: '在「常見問題」頁或自訂頁面加入「常見問答」區塊' },
  ];
  out.aio.site = [
    { ok: s.aio_ld === '1', msg: '輸出結構化資料（商品、麵包屑、商品清單、網站搜尋）', fix: '下方設定開啟' },
    { ok: true, msg: 'Google 爬蟲（Googlebot）可以讀取網站', fix: '' },
    { ok: true, msg: '提供 sitemap.xml（含更新日期）', fix: '' },
    { ok: !placeholder(s.company_name), msg: '公司資料完整（Google 判斷可信度）', fix: '商店設定 → 公司全名' },
  ];
  for (const c of Object.keys(CATS)) {
    const o = out[c];
    const itemScore = o.items.length ? Math.round(o.items.reduce((a, i) => a + i.score, 0) / o.items.length) : 100;
    const siteScore = Math.round((o.site.filter((x) => x.ok).length / o.site.length) * 100);
    Object.assign(o, { ...CATS[c], key: c, itemScore, siteScore, score: Math.round(itemScore * 0.75 + siteScore * 0.25), fixable: o.items.reduce((a, i) => a + i.auto, 0) });
  }
  return { cats: out, score: Math.round((out.geo.score + out.aeo.score + out.aio.score) / 3) };
}

// ---------- 自動優化（只補空白，除非指定覆蓋） ----------
function autoFix({ targets = ['meta', 'summary', 'faq', 'category', 'pages'], overwrite = false } = {}) {
  const cms = require('./cms');
  const n = { meta: 0, summary: 0, faq: 0, category: 0, pages: 0 };
  tx(() => {
    for (const p of all('SELECT * FROM products WHERE published = 1')) {
      if (targets.includes('meta') && (overwrite || !(p.meta_description || '').trim())) run('UPDATE products SET meta_description = ? WHERE id = ?', genProductMeta(p), p.id), n.meta++;
      if (targets.includes('summary') && (overwrite || !(p.summary || '').trim())) run('UPDATE products SET summary = ? WHERE id = ?', genProductSummary(p), p.id), n.summary++;
      if (targets.includes('faq') && (overwrite || parseFaq(p.faq).length < 3)) {
        const mine = overwrite ? [] : parseFaq(p.faq);
        const add = genProductFaq(p).filter((x) => !mine.some((m) => m.q === x.q));
        run('UPDATE products SET faq = ? WHERE id = ?', JSON.stringify([...mine, ...add].slice(0, Math.max(mine.length, num('aeo_faq_max', 6)))), p.id), n.faq++;
      }
    }
    if (targets.includes('category')) {
      for (const c of all('SELECT * FROM categories WHERE published = 1')) {
        if (overwrite || !(c.seo_intro || '').trim()) run('UPDATE categories SET seo_intro = ? WHERE id = ?', genCategoryIntro(c), c.id), n.category++;
      }
    }
    if (targets.includes('pages')) {
      for (const pg of all("SELECT * FROM pages WHERE slug != 'home'")) {
        if (overwrite || !(pg.meta_description || '').trim()) {
          const full = cms.getPageById(pg.id);
          run('UPDATE pages SET meta_description = ? WHERE id = ?', genPageMeta(full), pg.id), n.pages++;
        }
      }
    }
  });
  return n;
}
// 儲存商品時自動補齊（設定開啟時）
function autoFillProduct(id) {
  const s = settings();
  const p = get('SELECT * FROM products WHERE id = ?', id);
  if (!p) return;
  if (s.aio_auto === '1' && !(p.meta_description || '').trim()) run('UPDATE products SET meta_description = ? WHERE id = ?', genProductMeta(p), id);
  if (s.aeo_auto === '1' && !(p.summary || '').trim()) run('UPDATE products SET summary = ? WHERE id = ?', genProductSummary(p), id);
  if (s.aeo_auto === '1' && parseFaq(p.faq).length < 3) {
    const mine = parseFaq(p.faq);
    run('UPDATE products SET faq = ? WHERE id = ?', JSON.stringify([...mine, ...genProductFaq(p).filter((x) => !mine.some((m) => m.q === x.q))].slice(0, Math.max(mine.length, num('aeo_faq_max', 6)))), id);
  }
}
function suggestForProduct(id) {
  const p = get('SELECT * FROM products WHERE id = ?', id);
  if (!p) return null;
  return { meta_description: genProductMeta(p), summary: genProductSummary(p), faq: faqToText(genProductFaq(p)) };
}

// ---------- llms.txt ----------
function llmsTxt(base, full = false) {
  const s = settings();
  const cats = all('SELECT * FROM categories WHERE published = 1 ORDER BY sequence, id');
  const prods = all('SELECT * FROM products WHERE published = 1 ORDER BY sold_count DESC, sequence, id');
  const pages = all("SELECT * FROM pages WHERE published = 1 AND slug != 'home' ORDER BY system DESC, id");
  const L = [];
  L.push(`# ${s.store_name}`, '', `> ${siteSummary()}`, '');
  if (!placeholder(s.company_name)) L.push(`- 公司：${s.company_name}${placeholder(s.tax_id) ? '' : `（統一編號 ${s.tax_id}）`}`);
  if (!placeholder(s.license_no)) L.push(`- 醫療器材販賣業藥商許可執照：${s.license_no}`);
  if (!placeholder(s.phone)) L.push(`- 客服電話：${s.phone}（${s.service_hours}）`);
  if (!placeholder(s.address)) L.push(`- 地址：${s.address}`);
  L.push(`- 運費：宅配 ${money(s.shipping_home)}、超商取貨 ${money(s.shipping_cvs)}；單筆滿 ${money(s.free_shipping_threshold)} 免運`, `- 出貨：付款後 ${s.ship_days} 個工作天內出貨`, '- 退換貨：到貨 7 天鑑賞期（已拆封個人衛生用品除外）', '');
  L.push('## 商品分類', '');
  for (const c of cats) L.push(`- [${c.name}](${base}/shop/category/${encodeURIComponent(c.name)}-${c.id})${c.seo_intro || c.description ? '：' + clip(c.seo_intro || c.description, 120) : ''}`);
  L.push('', '## 商品', '');
  for (const p of prods) {
    L.push(`- [${p.name}](${base}${prodUrl(p)})：${money(p.price)}。${clip(p.meta_description || p.description, full ? 300 : 110)}${p.license_no ? `（許可證：${p.license_no}）` : ''}`);
    if (full) {
      if (p.summary) L.push(...p.summary.split('\n').map((x) => `  - ${x}`));
      for (const f of parseFaq(p.faq)) L.push(`  - 問：${f.q} 答：${f.a}`);
    }
  }
  L.push('', '## 購物說明與政策', '');
  for (const pg of pages) L.push(`- [${pg.title}](${base}${pageUrl(pg)})${pg.meta_description ? '：' + clip(pg.meta_description, 120) : ''}`);
  L.push(`- [聯絡我們](${base}/contactus)`, `- [訂單查詢](${base}/order-lookup)`);
  if (!full) L.push('', '## 完整版', '', `- [llms-full.txt](${base}/llms-full.txt)：包含每個商品的重點摘要與常見問答`);
  return L.join('\n') + '\n';
}

function robotsTxt(base) {
  const s = settings();
  const L = ['User-agent: *', 'Disallow: /admin', 'Disallow: /my', 'Disallow: /shop/cart', 'Disallow: /shop/checkout', 'Disallow: /order-lookup/', ''];
  const group = (title, bots, allow) => {
    L.push(`# ${title}：${allow ? '允許' : '禁止'}`);
    for (const bot of bots) L.push(`User-agent: ${bot}`, allow ? 'Allow: /' : 'Disallow: /', ...(allow ? ['Disallow: /admin', 'Disallow: /my', 'Disallow: /shop/checkout'] : []), '');
  };
  group('AI 回答用爬蟲', ANSWER_BOTS, s.geo_bots_answer !== 'block');
  group('AI 訓練用爬蟲', TRAIN_BOTS, s.geo_bots_train !== 'block');
  L.push(`Sitemap: ${base}/sitemap.xml`);
  if (s.geo_llms === '1') L.push(`# AI 網站摘要：${base}/llms.txt`);
  return L.join('\n') + '\n';
}

// 從頁面區塊抽出問答（給 FAQPage 結構化資料）
function faqFromBlocks(blocks) {
  const out = [];
  const s = settings();
  const tok = (t) => String(t || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in s ? s[k] : m));
  for (const b of blocks || []) {
    if (b.type === 'faq') for (const it of b.data.items || []) if (it.q && it.a) out.push({ q: strip(tok(it.q)), a: strip(tok(it.a)) });
    if (b.type === 'html') {
      const html = (b.data.html && b.data.html.html) || '';
      for (const m of html.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)) {
        const q = strip(tok(m[1])).replace(/^Q[:：]\s*/, '');
        const a = strip(tok(m[2])).replace(/^A[:：]\s*/, '');
        if (q && a) out.push({ q, a });
      }
    }
  }
  return out;
}

module.exports = {
  CATS, ANSWER_BOTS, TRAIN_BOTS, AI_BOTS, audit, autoFix, autoFillProduct, suggestForProduct, llmsTxt, robotsTxt, siteSummary,
  parseFaq, faqFromText, faqToText, faqFromBlocks, genProductMeta, clip, strip,
};
