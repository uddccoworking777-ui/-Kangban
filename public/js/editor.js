// 網站編輯器（只在管理員的編輯模式載入）
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = window.CMS.csrf;
  const changes = {};
  const status = $('[data-cms-status]');
  const dirty = () => Object.keys(changes).length > 0;
  const mark = (key, value) => {
    changes[key] = value;
    status.textContent = `${Object.keys(changes).length} 項修改未儲存`;
    status.classList.add('on');
  };
  const api = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '儲存失敗');
    return data;
  };
  const save = async () => {
    if (!dirty()) return true;
    status.textContent = '儲存中…';
    try {
      await api('/admin/cms/save', { changes });
      for (const k of Object.keys(changes)) delete changes[k];
      status.textContent = '已儲存 ✓';
      setTimeout(() => !dirty() && (status.textContent = ''), 2000);
      return true;
    } catch (e) {
      status.textContent = e.message;
      alert(e.message);
      return false;
    }
  };
  addEventListener('beforeunload', (e) => {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  $('[data-cms-save]').addEventListener('click', save);
  $('[data-cms-discard]').addEventListener('click', () => {
    if (!dirty() || confirm('確定放棄所有未儲存的修改？')) {
      for (const k of Object.keys(changes)) delete changes[k];
      location.reload();
    }
  });
  $('[data-cms-exit]').addEventListener('click', async (e) => {
    if (dirty()) {
      e.preventDefault();
      if (await save()) location.href = e.currentTarget.href;
    }
  });

  // ---------- 文字 ----------
  const supportsPlain = (() => {
    const d = document.createElement('div');
    d.contentEditable = 'plaintext-only';
    return d.contentEditable === 'plaintext-only';
  })();
  $$('[data-edit-text]').forEach((el) => {
    el.contentEditable = supportsPlain ? 'plaintext-only' : 'true';
    el.spellcheck = false;
    el.classList.add('cms-editable');
    const multi = el.tagName === 'P';
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multi && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    el.addEventListener('click', (e) => e.preventDefault());
    el.addEventListener('input', () => mark(el.dataset.editText, el.innerText.replace(/\n$/, '')));
    if (el.dataset.raw !== undefined) {
      // 含有 {{代碼}} 的文字：編輯時顯示代碼，沒改就恢復顯示實際值
      const shown = el.innerHTML;
      el.title = '這段文字包含自動帶入的資料（例如 {{free_shipping_threshold}}），保留代碼就會自動更新';
      el.addEventListener('focus', () => (el.innerText = el.dataset.raw));
      el.addEventListener('blur', () => {
        if (!(el.dataset.editText in changes)) el.innerHTML = shown;
      });
    }
  });

  // ---------- 圖文編輯 ----------
  const rtb = $('[data-rtb]');
  let richEl = null;
  $$('[data-edit-html]').forEach((el) => {
    el.contentEditable = 'true';
    el.classList.add('cms-editable', 'cms-rich');
    el.addEventListener('focus', () => {
      richEl = el;
      rtb.hidden = false;
    });
    el.addEventListener('input', () => mark(el.dataset.editHtml, { html: el.innerHTML }));
    el.addEventListener('click', (e) => e.target.closest('a') && e.preventDefault());
  });
  document.addEventListener('focusin', (e) => {
    if (!e.target.closest('[data-edit-html]') && !e.target.closest('[data-rtb]')) rtb.hidden = true;
  });
  rtb.addEventListener('mousedown', (e) => e.preventDefault());
  rtb.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b || !richEl) return;
    const cmd = b.dataset.cmd;
    if (['h2', 'h3', 'p'].includes(cmd)) document.execCommand('formatBlock', false, cmd);
    else if (cmd === 'createLink') {
      const url = prompt('連結網址（例如 /shop 或 https://…）');
      if (url) document.execCommand('createLink', false, url);
    } else document.execCommand(cmd);
    mark(richEl.dataset.editHtml, { html: richEl.innerHTML });
  });

  // ---------- 連結／按鈕 ----------
  const linkDlg = $('#cms-link-dialog');
  const pick = linkDlg.querySelector('[name=pick]');
  fetch('/admin/cms/targets')
    .then((r) => r.json())
    .then((t) => {
      for (const [label, items] of Object.entries(t)) {
        const g = document.createElement('optgroup');
        g.label = label;
        for (const it of items) g.append(new Option(it.title, it.url));
        pick.append(g);
      }
    });
  pick.addEventListener('change', () => pick.value && (linkDlg.querySelector('[name=href]').value = pick.value));
  const linkState = (el) => changes[el.dataset.editLink] || { text: el.dataset.linkTextless !== undefined ? '' : el.innerText.trim(), href: el.getAttribute('href') || '', newTab: el.target === '_blank' };
  const openLink = (el) => {
    const v = linkState(el);
    const f = linkDlg.querySelector('form');
    const textless = el.dataset.linkTextless !== undefined;
    linkDlg.querySelector('[data-link-text-row]').hidden = textless;
    f.text.value = v.text;
    f.href.value = v.href;
    f.newTab.checked = v.newTab;
    pick.value = '';
    linkDlg.returnValue = '';
    linkDlg.showModal();
    linkDlg.onclose = () => {
      if (linkDlg.returnValue !== 'ok') return;
      const nv = { text: textless ? '' : f.text.value.trim(), href: f.href.value.trim(), newTab: f.newTab.checked };
      if (!textless) el.textContent = nv.text;
      el.setAttribute('href', nv.href || '#');
      mark(el.dataset.editLink, nv);
    };
  };
  $$('[data-edit-link]').forEach((el) => {
    el.classList.add('cms-link');
    if (el.dataset.linkTextless !== undefined || el.querySelector('[data-edit-text]')) {
      // 整張卡片是連結、裡面的文字另外可編輯：加一個「連結」小按鈕
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cms-chip';
      chip.textContent = '編輯連結';
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLink(el);
      });
      el.style.position ||= 'relative';
      el.append(chip);
      el.addEventListener('click', (e) => e.preventDefault());
    } else {
      el.title = '點一下修改按鈕文字與連結';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openLink(el);
      });
    }
  });

  // ---------- 圖片 ----------
  const imgDlg = $('#cms-img-dialog');
  const openImg = (current, apply) => {
    const f = imgDlg.querySelector('form');
    f.reset();
    imgDlg.querySelector('.cms-preview').src = current;
    imgDlg.querySelector('[data-img-note]').textContent = '';
    imgDlg.returnValue = '';
    imgDlg.showModal();
    imgDlg.onclose = async () => {
      if (imgDlg.returnValue !== 'ok') return;
      let url = f.url.value.trim();
      if (f.file.files[0]) {
        const fd = new FormData();
        fd.append('file', f.file.files[0]);
        status.textContent = '上傳中…';
        const res = await fetch('/admin/cms/upload?_csrf=' + encodeURIComponent(csrf), { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || '上傳失敗');
        url = data.url;
        status.textContent = '';
      }
      if (url) apply(url);
    };
  };
  $$('img[data-edit-img]').forEach((img) => {
    img.classList.add('cms-img');
    img.title = '點一下更換圖片';
    img.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openImg(img.src, (url) => {
        img.src = url;
        mark(img.dataset.editImg, url);
      });
    });
  });
  $$('[data-edit-bg]').forEach((el) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cms-chip cms-chip-bg';
    b.textContent = '更換背景圖';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = (getComputedStyle(el).backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || '';
      openImg(cur, (url) => {
        el.style.backgroundImage = `url('${url}')`;
        mark(el.dataset.editBg, url);
      });
    });
    el.style.position ||= 'relative';
    el.append(b);
  });

  // ---------- 區塊操作 ----------
  const blockApi = async (body) => {
    if (dirty() && !(await save())) return;
    try {
      await api('/admin/cms/block', body);
      location.reload();
    } catch (e) {
      alert(e.message);
    }
  };
  $$('[data-block-op]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const blockEl = b.closest('[data-block-index]');
      const pageId = b.closest('[data-page-id]').dataset.pageId;
      const op = b.dataset.blockOp;
      if (op === 'delete' && !confirm(b.dataset.sys ? '刪除這個首頁內建區塊？\n之後可以用「＋ 新增區塊」→「加回首頁內建區塊」加回來，文字和圖片都會保留。' : '確定刪除這個區塊？刪除後無法復原。')) return;
      if (op === 'remove-slide' && !confirm('刪除這張主視覺圖片？')) return;
      if (op === 'remove-item' && !confirm('確定移除這一項？')) return;
      blockApi({ pageId, op, at: blockEl.dataset.blockIndex, to: b.dataset.to, field: b.dataset.field });
    })
  );
  $$('[data-block-set]').forEach((s) =>
    s.addEventListener('change', () => {
      const blockEl = s.closest('[data-block-index]');
      blockApi({ pageId: s.closest('[data-page-id]').dataset.pageId, op: 'set', at: blockEl.dataset.blockIndex, field: s.dataset.blockSet, to: s.value });
    })
  );
  const addDlg = $('#cms-add-dialog');
  $$('[data-block-add]').forEach((b) =>
    b.addEventListener('click', () => {
      addDlg.returnValue = '';
      addDlg.showModal();
      addDlg.onclose = () => {
        const type = addDlg.returnValue;
        if (!type || type === 'cancel') return;
        blockApi({ pageId: b.closest('[data-page-id]').dataset.pageId, op: 'add', at: b.dataset.blockAdd, type });
      };
    })
  );

  // ---------- 刪除／復原版面區塊（首頁原本的區塊、頁尾保障列） ----------
  $$('[data-section-op]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = b.closest('[data-section]').dataset.section;
      const hide = b.dataset.sectionOp === 'hide';
      if (hide && !confirm(`刪除「${b.dataset.label}」？\n刪除後顧客就看不到；在編輯模式可以隨時「復原」。`)) return;
      if (dirty() && !(await save())) return;
      const list = new Set(window.CMS.hidden || []);
      if (hide) list.add(id);
      else list.delete(id);
      try {
        await api('/admin/cms/save', { changes: { 'layout.hidden': JSON.stringify([...list]) } });
        location.reload();
      } catch (err) {
        alert(err.message);
      }
    })
  );
})();
