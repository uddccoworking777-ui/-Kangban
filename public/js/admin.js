(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // 整列可點
  $$('tr[data-href]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select,label')) return;
      location.href = tr.dataset.href;
    })
  );

  // 刪除前確認
  $$('[data-confirm]').forEach((b) => b.addEventListener('click', (e) => { if (!confirm(b.dataset.confirm)) e.preventDefault(); }));

  // 下拉選單變更即送出
  $$('[data-autosubmit]').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // 重設密碼
  $$('form[data-prompt-password]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      const pw = prompt('請輸入新密碼（至少 8 個字元）');
      if (!pw || pw.length < 8) { e.preventDefault(); if (pw) alert('密碼至少 8 個字元'); return; }
      f.password.value = pw;
    })
  );

  // 批次選取
  const bulk = $('form[data-bulk]');
  if (bulk) {
    const bar = $('.bulk-bar', bulk);
    const update = () => {
      const n = $$('input[name=ids]:checked', bulk).length;
      bar.hidden = !n;
      $('[data-bulk-count]', bulk).textContent = n;
    };
    $('[data-check-all]', bulk)?.addEventListener('change', (e) => { $$('input[name=ids]', bulk).forEach((c) => (c.checked = e.target.checked)); update(); });
    bulk.addEventListener('change', update);
  }

  // 圖表提示
  $$('[data-chart]').forEach((chart) => {
    const tip = $('.tip', chart);
    $$('.bar-g', chart).forEach((g) => {
      const show = () => {
        const r = g.getBoundingClientRect(), c = chart.getBoundingClientRect();
        tip.textContent = g.dataset.tip.replace(/｜/g, '　');
        tip.style.left = r.left - c.left + r.width / 2 + 'px';
        tip.style.top = Math.max(30, g.querySelector('.bar')?.getBoundingClientRect().top - c.top || r.height) + 'px';
        tip.hidden = false;
      };
      g.addEventListener('mouseenter', show);
      g.addEventListener('mouseleave', () => (tip.hidden = true));
      g.addEventListener('touchstart', show, { passive: true });
    });
  });

  // 點一下複製
  $$('.copy').forEach((c) => c.addEventListener('click', () => { navigator.clipboard?.writeText(c.textContent.trim()); c.title = '已複製'; }));
})();

(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  // 按 / 聚焦全站搜尋
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      document.querySelector('.gsearch input')?.focus();
    }
  });
  // 商品列表直接改庫存
  document.querySelectorAll('[data-stock]').forEach((inp) => {
    let last = inp.value;
    const save = async () => {
      if (inp.value === last) return;
      const res = await fetch(`/admin/products/${inp.dataset.stock}/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf },
        body: new URLSearchParams({ stock: inp.value }),
      });
      if (res.ok) {
        last = inp.value;
        inp.classList.add('saved');
        setTimeout(() => inp.classList.remove('saved'), 1200);
      } else alert('儲存失敗');
    };
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('change', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
  // 插入尺寸表範本
  document.querySelector('[data-insert-size]')?.addEventListener('click', () => {
    const ta = document.querySelector('[data-size-chart]');
    if (ta.value.trim() && !confirm('會覆蓋目前的尺寸表內容，確定嗎？')) return;
    ta.value = '<table>\n<thead><tr><th>尺寸</th><th>量測部位周長</th></tr></thead>\n<tbody>\n<tr><td>S</td><td>__–__ cm</td></tr>\n<tr><td>M</td><td>__–__ cm</td></tr>\n<tr><td>L</td><td>__–__ cm</td></tr>\n</tbody>\n</table>';
  });
})();

// 商品表單：AI 搜尋優化「自動產生建議」
(() => {
  const btn = document.querySelector('[data-geo-suggest]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const res = await fetch('/admin/geo/suggest/' + btn.dataset.geoSuggest);
    if (!res.ok) return alert('產生失敗');
    const sug = await res.json();
    const form = btn.closest('form');
    const filled = ['meta_description', 'summary', 'faq'].filter((k) => form[k].value.trim());
    const overwrite = filled.length ? confirm('有些欄位已經有內容。\n按「確定」全部換成建議內容；按「取消」只填入空白的欄位。') : true;
    for (const k of ['meta_description', 'summary', 'faq']) if (overwrite || !form[k].value.trim()) form[k].value = sug[k];
    btn.textContent = '已填入，記得儲存';
  });
  document.querySelectorAll('[data-count]').forEach((t) => {
    const hint = document.createElement('span');
    hint.className = 'hint';
    const upd = () => (hint.textContent = `目前 ${t.value.length} 字` + (t.value.length && (t.value.length < 70 || t.value.length > 160) ? '（建議 70–150 字）' : ''));
    t.after(hint);
    t.addEventListener('input', upd);
    upd();
  });
})();
