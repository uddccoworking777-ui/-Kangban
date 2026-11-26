// AI 搜尋成效追蹤：記錄 AI／搜尋引擎爬蟲造訪、從 AI 點進來的訪客，以及他們帶來的訂單。
// 不記錄 IP、不記錄個人資料；只存「日期、來源、頁面、次數」。
const { db, all, get, run } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS traffic_daily (
  day TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, path TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, source, path));
CREATE TABLE IF NOT EXISTS traffic_recent (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now','localtime')), kind TEXT NOT NULL, source TEXT NOT NULL, path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_checks (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL, tool TEXT NOT NULL, question TEXT NOT NULL, result TEXT NOT NULL,
  note TEXT, admin_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS idx_traffic_day ON traffic_daily(day);
`);
{
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('source')) db.exec('ALTER TABLE orders ADD COLUMN source TEXT');
}

// kind：ai_bot（AI 爬蟲）、search_bot（搜尋引擎爬蟲）、ai_ref（從 AI 點進來）、search_ref（從搜尋引擎點進來）
const AI_BOTS = [
  ['OAI-SearchBot', 'ChatGPT 搜尋'], ['ChatGPT-User', 'ChatGPT（使用者點選）'], ['GPTBot', 'ChatGPT（模型訓練）'],
  ['Claude-SearchBot', 'Claude 搜尋'], ['Claude-User', 'Claude（使用者點選）'], ['ClaudeBot', 'Claude（模型訓練）'],
  ['Perplexity-User', 'Perplexity（使用者點選）'], ['PerplexityBot', 'Perplexity'],
  ['Google-CloudVertexBot', 'Google Vertex AI'], ['DuckAssistBot', 'DuckDuckGo AI'], ['MistralAI-User', 'Mistral'],
  ['meta-externalagent', 'Meta AI'], ['Amazonbot', 'Amazon'], ['Applebot', 'Apple'], ['Bytespider', '字節跳動'],
  ['CCBot', 'Common Crawl'], ['cohere-ai', 'Cohere'],
];
const SEARCH_BOTS = [['Googlebot', 'Google'], ['bingbot', 'Bing'], ['DuckDuckBot', 'DuckDuckGo'], ['YandexBot', 'Yandex'], ['Baiduspider', '百度']];
const AI_REFS = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, 'ChatGPT'], [/(^|\.)perplexity\.ai$/, 'Perplexity'],
  [/^gemini\.google\.com$|^bard\.google\.com$/, 'Gemini'], [/^copilot\.microsoft\.com$/, 'Copilot'], [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)poe\.com$/, 'Poe'], [/(^|\.)you\.com$/, 'You.com'], [/(^|\.)deepseek\.com$/, 'DeepSeek'], [/(^|\.)grok\.com$|(^|\.)x\.ai$/, 'Grok'],
  [/(^|\.)meta\.ai$/, 'Meta AI'], [/(^|\.)phind\.com$/, 'Phind'],
];
const UTM_AI = [[/chatgpt|openai/i, 'ChatGPT'], [/perplexity/i, 'Perplexity'], [/copilot/i, 'Copilot'], [/gemini/i, 'Gemini'], [/claude/i, 'Claude']];
const SEARCH_REFS = [[/(^|\.)google\.[a-z.]+$/, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/(^|\.)yahoo\.com$|(^|\.)yahoo\.co\.jp$/, 'Yahoo'], [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo']];

function classify(req) {
  const ua = String(req.get('user-agent') || '');
  const low = ua.toLowerCase();
  for (const [k, name] of AI_BOTS) if (low.includes(k.toLowerCase())) return { kind: 'ai_bot', source: name };
  for (const [k, name] of SEARCH_BOTS) if (low.includes(k.toLowerCase())) return { kind: 'search_bot', source: name };
  const utm = String(req.query.utm_source || '');
  for (const [re, name] of UTM_AI) if (utm && re.test(utm)) return { kind: 'ai_ref', source: name };
  let host = '';
  try {
    host = new URL(req.get('referer') || '').hostname.toLowerCase();
  } catch {}
  if (!host || host === String(req.hostname || '').toLowerCase()) return null;
  for (const [re, name] of AI_REFS) if (re.test(host)) return { kind: 'ai_ref', source: name };
  for (const [re, name] of SEARCH_REFS) if (re.test(host)) return { kind: 'search_ref', source: name };
  return null;
}

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
};
function record(kind, source, path) {
  const p = String(path || '/').slice(0, 200);
  run(
    'INSERT INTO traffic_daily (day, kind, source, path, hits) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, kind, source, path) DO UPDATE SET hits = hits + 1',
    today(), kind, source, p
  );
  run('INSERT INTO traffic_recent (kind, source, path) VALUES (?, ?, ?)', kind, source, p);
}
let lastPrune = 0;
function prune() {
  if (Date.now() - lastPrune < 6 * 3600e3) return;
  lastPrune = Date.now();
  run("DELETE FROM traffic_daily WHERE day < date('now','localtime','-400 days')");
  run('DELETE FROM traffic_recent WHERE id <= (SELECT MAX(id) FROM traffic_recent) - 1000');
}

const SKIP = /^\/(admin|css|js|img|uploads|api|favicon)/;
function middleware(req, res, next) {
  if (req.method !== 'GET' || SKIP.test(req.path)) return next();
  try {
    const c = classify(req);
    if (c) {
      let path = req.path;
      try {
        path = decodeURIComponent(req.path);
      } catch {}
      record(c.kind, c.source, path);
      // 從 AI 點進來的訪客：記在這次瀏覽（session），下單時就能知道訂單來自哪個 AI
      if (c.kind === 'ai_ref' && req.session && !req.session.aiSource) req.session.aiSource = c.source;
      prune();
    }
  } catch (e) {
    console.error('[track]', e.message);
  }
  next();
}

// ---------- 報表 ----------
function report(days = 30) {
  const since = `date('now','localtime','-${days - 1} days')`;
  const sum = (kind) => all(`SELECT source, SUM(hits) AS hits, MAX(day) AS last FROM traffic_daily WHERE kind = ? AND day >= ${since} GROUP BY source ORDER BY hits DESC`, kind);
  const total = (kind) => get(`SELECT COALESCE(SUM(hits),0) AS n FROM traffic_daily WHERE kind = ? AND day >= ${since}`, kind).n;
  const daily = (kind) => {
    const rows = Object.fromEntries(all(`SELECT day, SUM(hits) AS n FROM traffic_daily WHERE kind = ? AND day >= ${since} GROUP BY day`, kind).map((r) => [r.day, r.n]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      const key = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
      out.push({ d: key, n: rows[key] || 0 });
    }
    return out;
  };
  const topPaths = (kind) => all(`SELECT path, SUM(hits) AS hits FROM traffic_daily WHERE kind = ? AND day >= ${since} GROUP BY path ORDER BY hits DESC LIMIT 10`, kind);
  const files = all(
    `SELECT path, SUM(hits) AS hits, GROUP_CONCAT(DISTINCT source) AS sources, MAX(day) AS last FROM traffic_daily
     WHERE kind IN ('ai_bot','search_bot') AND path IN ('/llms.txt','/llms-full.txt','/robots.txt','/sitemap.xml') AND day >= ${since} GROUP BY path`
  );
  const aiOrders = all(
    `SELECT source, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders
     WHERE source IS NOT NULL AND status != 'cancelled' AND date(created_at) >= ${since} GROUP BY source ORDER BY amount DESC`
  );
  return {
    days,
    aiBotTotal: total('ai_bot'),
    searchBotTotal: total('search_bot'),
    aiRefTotal: total('ai_ref'),
    searchRefTotal: total('search_ref'),
    aiBots: sum('ai_bot'),
    searchBots: sum('search_bot'),
    aiRefs: sum('ai_ref'),
    searchRefs: sum('search_ref'),
    aiRefDaily: daily('ai_ref'),
    aiBotDaily: daily('ai_bot'),
    aiBotPaths: topPaths('ai_bot'),
    aiRefPaths: topPaths('ai_ref'),
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    aiOrders,
    aiOrderCount: aiOrders.reduce((a, r) => a + r.n, 0),
    aiOrderAmount: aiOrders.reduce((a, r) => a + r.amount, 0),
    recent: all("SELECT * FROM traffic_recent WHERE kind IN ('ai_bot','ai_ref') ORDER BY id DESC LIMIT 15"),
    hasAnyData: get('SELECT COUNT(*) AS n FROM traffic_daily').n > 0,
  };
}

// ---------- 手動檢查紀錄 ----------
const CHECK_TOOLS = ['ChatGPT', 'Perplexity', 'Gemini', 'Google AI 摘要', 'Copilot', 'Claude'];
const CHECK_RESULTS = { cited: '有引用或推薦本站', mentioned: '有提到品牌，但沒有連結', none: '沒有出現' };
function addCheck({ day, tool, question, result, note, admin }) {
  run('INSERT INTO ai_checks (day, tool, question, result, note, admin_name) VALUES (?, ?, ?, ?, ?, ?)', day, tool, question, result, note || '', admin || '');
}
const listChecks = () => all('SELECT * FROM ai_checks ORDER BY day DESC, id DESC LIMIT 50');
const deleteCheck = (id) => run('DELETE FROM ai_checks WHERE id = ?', Number(id));

module.exports = { middleware, classify, record, report, AI_BOTS, SEARCH_BOTS, CHECK_TOOLS, CHECK_RESULTS, addCheck, listChecks, deleteCheck };
