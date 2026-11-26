// 把登入狀態和購物車存進 SQLite，重新啟動網站後不會遺失
const session = require('express-session');
const { run, get } = require('./db');

class SqliteStore extends session.Store {
  constructor(ttlMs = 1000 * 60 * 60 * 24 * 30) {
    super();
    this.ttl = ttlMs;
    setInterval(() => run('DELETE FROM sessions WHERE expires < ?', Date.now()), 60 * 60 * 1000).unref();
  }
  expiry(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttl;
  }
  get(sid, cb) {
    try {
      const row = get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }
  set(sid, sess, cb) {
    try {
      run(
        'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires',
        sid, JSON.stringify(sess), this.expiry(sess)
      );
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
  destroy(sid, cb) {
    try {
      run('DELETE FROM sessions WHERE sid = ?', sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
  touch(sid, sess, cb) {
    try {
      run('UPDATE sessions SET expires = ? WHERE sid = ?', this.expiry(sess), sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
}
module.exports = SqliteStore;
