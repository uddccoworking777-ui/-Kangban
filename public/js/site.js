(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = $('meta[name="csrf-token"]').content;
  const money = (n) => 'NT$ ' + Math.round(n).toLocaleString('en-US');

  async function post(url, data) {
    const body = new URLSearchParams({ _csrf: csrf, ...data });
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error('request failed');
    return res.json();
  }

  let toastTimer;
  function toast(html) {
    const t = $('.toast');
    t.innerHTML = html;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }
  function setBadge(sel, n) {
    $$(sel).forEach((b) => {
      b.textContent = n;
      b.hidden = !n;
    });
  }

  // ---- 下拉選單 ----
  $$('.dropdown-toggle').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = btn.closest('.dropdown');
      const open = !dd.classList.contains('open');
      $$('.dropdown.open').forEach((d) => d.classList.remove('open'));
      dd.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open);
    })
  );
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) $$('.dropdown.open').forEach((d) => d.classList.remove('open'));
  });

  // ---- 行動版選單 ----
  const drawer = $('.drawer');
  $$('[data-drawer-open]').forEach((b) => b.addEventListener('click', () => (drawer.hidden = false)));
  $$('[data-drawer-close]').forEach((b) => b.addEventListener('click', () => (drawer.hidden = true)));
  drawer?.addEventListener('click', (e) => e.target === drawer && (drawer.hidden = true));

  // ---- 搜尋（即時建議） ----
  const input = $('[data-search-input]');
  const results = $('[data-search-results]');
  const hideResults = () => results && (results.hidden = true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideResults();
      if (drawer) drawer.hidden = true;
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) hideResults();
  });
  input?.addEventListener('focus', () => results.innerHTML && (results.hidden = false));
  let searchTimer;
  input?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return ((results.innerHTML = ''), hideResults());
    searchTimer = setTimeout(async () => {
      results.hidden = false;
      results.innerHTML = '<p class="muted small">搜尋中…</p>';
      const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then((x) => x.json());
      if (input.value.trim() !== q) return;
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      results.innerHTML =
        r.items
          .map((i) => `<a href="${i.url}"><img src="${i.image}" alt=""><span>${esc(i.name)}</span><span class="sr-price">${i.price}</span></a>`)
          .join('') +
        `<p class="small muted">${r.total} 項結果${r.total ? ` · <a href="/shop?search=${encodeURIComponent(q)}">查看全部</a>` : ''}</p>`;
    }, 220);
  });

  // ---- 數量 +/- ----
  $$('[data-qty]').forEach((b) =>
    b.addEventListener('click', () => {
      const inp = b.parentElement.querySelector('input');
      const min = Number(inp.min || 0);
      inp.value = Math.max(min, Math.min(999, Number(inp.value || 0) + Number(b.dataset.qty)));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })
  );

  // ---- 加入購物車 ----
  $$('form[data-add-cart]').forEach((f) =>
    f.addEventListener('submit', async (e) => {
      if (e.submitter?.hasAttribute('data-no-ajax')) return;
      e.preventDefault();
      const data = Object.fromEntries(new FormData(f));
      delete data._csrf;
      try {
        const r = await post(f.action, data);
        setBadge('[data-cart-count]', r.count);
        toast(r.warning ? `${r.warning}，已調整購物車數量 <a href="/shop/cart">查看購物車</a>` : `已將「${r.name}」加入購物車 <a href="/shop/cart">查看購物車</a>`);
      } catch {
        f.submit();
      }
    })
  );

  // ---- 購物車更新數量 / 移除 ----
  function applyCart(r, line) {
    setBadge('[data-cart-count]', r.count);
    if (r.warning) toast(r.warning);
    if (line && r.qty) $('input[name="set_qty"]', line).value = r.qty;
    if (!r.count) return location.reload();
    if (line) {
      if (r.qty === 0) line.remove();
      else $('[data-line-sub]', line).textContent = r.lineSubtotal;
    }
    $('[data-subtotal]').textContent = r.subtotal;
    const sp = $('[data-ship-progress]');
    if (sp) {
      const th = Number(sp.dataset.threshold), gap = Math.max(0, th - r.subtotalRaw);
      $('[data-ship-msg]', sp).innerHTML = gap ? `再買 <b>${money(gap)}</b> 即可免運` : '已達免運門檻 ✓';
      $('.bar span', sp).style.width = Math.min(100, (r.subtotalRaw / th) * 100) + '%';
    }
    $('[data-fee]').textContent = r.fee;
    $('[data-total]').textContent = r.total;
  }
  $$('form[data-cart-qty]').forEach((f) => {
    let t;
    f.addEventListener('submit', (e) => e.preventDefault());
    f.querySelector('input[name="set_qty"]').addEventListener('change', (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const r = await post(f.action, { product_id: f.product_id.value, set_qty: e.target.value });
        applyCart(r, f.closest('[data-line]'));
      }, 250);
    });
  });
  $$('form[data-cart-remove]').forEach((f) =>
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await post(f.action, { product_id: f.product_id.value, set_qty: 0 });
      applyCart(r, f.closest('[data-line]'));
    })
  );

  // ---- 願望清單 / 比較 ----
  function bindToggle(attr, url, badgeSel, onText, offText) {
    $$(`[${attr}]`).forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = b.getAttribute(attr);
        const r = await post(url, { product_id: id });
        if (badgeSel) setBadge(badgeSel, r.count);
        if (b.hasAttribute('data-reload')) return location.reload();
        $$(`[${attr}="${id}"]`).forEach((x) => {
          x.classList.toggle('on', r.active);
          const use = x.querySelector('use');
          if (use && attr === 'data-wishlist') use.setAttribute('href', r.active ? '#i-heart-fill' : '#i-heart');
        });
        toast(r.active ? onText : offText);
      })
    );
  }
  bindToggle('data-wishlist', '/shop/wishlist/toggle', '[data-wishlist-count]', '已加入願望清單 <a href="/shop/wishlist">查看</a>', '已從願望清單移除');
  bindToggle('data-compare', '/shop/compare/toggle', null, '已加入比較（最多 4 項） <a href="/shop/compare">前往比較</a>', '已從比較移除');

  // ---- 商品圖庫 ----
  $$('[data-thumb]').forEach((b) =>
    b.addEventListener('click', () => {
      $('[data-gallery-main]').src = b.dataset.thumb;
      $$('[data-thumb]').forEach((x) => x.classList.toggle('on', x === b));
    })
  );

  // ---- 商店篩選 / 排序 ----
  $$('[data-autosubmit]').forEach((c) => c.addEventListener('change', () => c.form.submit()));
  $('[data-sort]')?.addEventListener('change', (e) => {
    const u = new URL(location.href);
    u.searchParams.set('sort', e.target.value);
    u.searchParams.delete('page');
    location.href = u;
  });
  $('[data-toggle-filters]')?.addEventListener('click', () => $('#filters').classList.toggle('show'));

  // ---- 結帳：依選項顯示欄位、計算運費 ----
  const co = $('form[data-checkout]');
  if (co) {
    const { subtotal, freeShip } = JSON.parse($('#co-data').textContent);
    const update = () => {
      const ship = co.querySelector('input[name="shipping"]:checked');
      const inv = co.querySelector('input[name="invoice"]:checked')?.value;
      $$('[data-ship]', co).forEach((el) => (el.hidden = el.dataset.ship !== ship?.value));
      $$('[data-inv]', co).forEach((el) => (el.hidden = el.dataset.inv !== inv));
      const fee = subtotal >= freeShip ? 0 : Number(ship?.dataset.fee || 0);
      $('[data-co-fee]').textContent = fee ? money(fee) : '免運';
      $('[data-co-total]').textContent = money(subtotal + fee);
      const cod = co.querySelector('input[name="payment"][value="cod"]');
      if (cod) {
        cod.disabled = ship?.value !== 'cvs';
        if (cod.disabled && cod.checked) co.querySelector('input[name="payment"][value="atm"]').checked = true;
      }
    };
    co.addEventListener('change', update);
    update();
  }

  // ---- 商品頁分頁 ----
  $$('[data-tabs]').forEach((wrap) => {
    const tabs = $$('[data-tab]', wrap);
    const show = (name) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name));
      $$('[data-panel]', wrap).forEach((p) => (p.hidden = p.dataset.panel !== name));
    };
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
    wrap.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || !e.target.dataset.tab) return;
      const i = tabs.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : -1);
      const t = tabs[(i + tabs.length) % tabs.length];
      t.focus();
      show(t.dataset.tab);
    });
  });

  // ---- 彈出視窗（尺寸表） ----
  $$('[data-open-modal]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.openModal)?.showModal()));
  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog.modal').forEach((d) => d.addEventListener('click', (e) => e.target === d && d.close()));

  // ---- 手機版固定購買列 ----
  const sticky = $('[data-sticky-buy]');
  const buyForm = $('#buy-form');
  if (sticky && buyForm && 'IntersectionObserver' in window) {
    const mq = matchMedia('(max-width: 860px)');
    new IntersectionObserver(([en]) => {
      const on = mq.matches && !en.isIntersecting && en.boundingClientRect.top < 0;
      sticky.hidden = !on;
      document.body.classList.toggle('has-sticky', on);
    }).observe(buyForm);
  }

  // ---- 回到頂端 ----
  const topBtn = $('[data-to-top]');
  if (topBtn) {
    addEventListener('scroll', () => (topBtn.hidden = scrollY < 600), { passive: true });
    topBtn.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
  }

  // ---- 橫向商品列（左右箭頭） ----
  $$('[data-rail]').forEach((rail) => {
    const track = $('[data-rail-track]', rail);
    const prev = $('[data-rail-prev]', rail);
    const next = $('[data-rail-next]', rail);
    const update = () => {
      prev.hidden = track.scrollLeft < 8;
      next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
    };
    const page = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: 'smooth' });
    prev.addEventListener('click', () => page(-1));
    next.addEventListener('click', () => page(1));
    track.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    rail._update = update;
    update();
  });

  // ---- 首頁「探索健康生活好物」分類篩選 ----
  $$('[data-filter-tabs]').forEach((tabs) => {
    const rail = tabs.nextElementSibling;
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      $$('[data-filter]', tabs).forEach((x) => x.setAttribute('aria-selected', x === b));
      const id = b.dataset.filter;
      $$('.rail-item', rail).forEach((it) => (it.hidden = Boolean(id) && !it.dataset.cats.includes(',' + id + ',')));
      $('[data-rail-track]', rail).scrollLeft = 0;
      if (rail._update) rail._update();
    });
  });

  // ---- 主視覺輪播（兩張以上自動輪播；滑鼠移上或聚焦時暫停；尊重「減少動態效果」設定） ----
  $$('[data-carousel]').forEach((car) => {
    const slides = $$('.slide', car);
    const dots = $$('[data-car-dot]', car);
    let i = 0;
    let timer = null;
    const go = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => {
        s.classList.toggle('on', k === i);
        s.setAttribute('aria-hidden', k === i ? 'false' : 'true');
        $$('a,button', s).forEach((el) => (el.tabIndex = k === i ? 0 : -1));
      });
      dots.forEach((d, k) => (k === i ? d.setAttribute('aria-current', 'true') : d.removeAttribute('aria-current')));
    };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const play = () => {
      if (reduce) return;
      clearInterval(timer);
      timer = setInterval(() => go(i + 1), 5000);
    };
    const stop = () => clearInterval(timer);
    $('[data-car-prev]', car).addEventListener('click', () => (go(i - 1), play()));
    $('[data-car-next]', car).addEventListener('click', () => (go(i + 1), play()));
    dots.forEach((d) => d.addEventListener('click', () => (go(Number(d.dataset.carDot)), play())));
    car.addEventListener('mouseenter', stop);
    car.addEventListener('mouseleave', play);
    car.addEventListener('focusin', stop);
    car.addEventListener('focusout', play);
    let x0 = null;
    car.addEventListener('touchstart', (e) => (x0 = e.touches[0].clientX), { passive: true });
    car.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1)), play();
      x0 = null;
    });
    go(0);
    play();
  });
})();
