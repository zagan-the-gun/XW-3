'use strict';

// XW-3 出品くん Filler — 出品ページに操作パネルを出す
// UIはShadow DOMに閉じ込める(サイトのCSSと干渉させず、
// fill.jsのラベル探索が自分のパネルを誤検出しないため)

(() => {
  const site = window.XW3.currentSite();
  if (!site) return;

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 320px; max-height: 78vh; display: flex; flex-direction: column;
      background: #fff; color: #1f2328; border: 1px solid #d0d7de; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.18); font-size: 13px; line-height: 1.5;
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eaeef2; }
    .head strong { font-size: 13px; flex: 1; }
    .head button { border: none; background: none; cursor: pointer; font-size: 15px; color: #6b7280; padding: 0 4px; }
    .body { padding: 10px 12px; overflow-y: auto; }
    .wrap.collapsed .body, .wrap.collapsed .foot { display: none; }
    select, button.act { width: 100%; font-size: 13px; }
    select { padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 8px; }
    label.chk { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: 12px; color: #57606a; }
    button.act {
      padding: 9px 12px; border-radius: 8px; border: 1px solid #1f6feb; background: #1f6feb; color: #fff;
      cursor: pointer; font-weight: 600; margin-top: 8px;
    }
    button.act:disabled { opacity: .5; cursor: default; }
    button.sub {
      margin-top: 6px; width: 100%; padding: 6px; font-size: 12px; border-radius: 8px;
      border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer;
    }
    .log { margin-top: 10px; border-top: 1px solid #eaeef2; padding-top: 8px; }
    .log div { display: flex; gap: 6px; padding: 2px 0; align-items: flex-start; }
    .log .ng { color: #b42318; }
    .log .ok { color: #067647; }
    .log small { color: #6b7280; }
    .note { color: #6b7280; font-size: 11px; margin-top: 8px; }
    .warn { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 8px; padding: 6px 8px; font-size: 11px; color: #7a4f01; }
    .warn a { color: #1f6feb; }
    #not-form { margin-bottom: 8px; }
  `;

  const host = document.createElement('div');
  host.id = 'xw3-filler-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${PANEL_CSS}</style>
    <div class="wrap" id="wrap">
      <div class="head">
        <!-- バージョンを出しておく。コード更新後にリロードし忘れると古い挙動のままになるため -->
        <strong>出品くん → ${site.name} <small style="color:#6b7280;font-weight:400">v${chrome.runtime.getManifest().version}</small></strong>
        <button id="toggle" title="開閉">－</button>
      </div>
      <div class="body">
        <div class="warn" id="not-form" hidden>
          このページは出品フォームではありません。
          <a href="${site.sellUrl}" target="_self">出品フォームを開く</a>
        </div>
        <select id="products"><option>読み込み中…</option></select>
        <div>
          <label class="chk"><input type="checkbox" id="c-text" checked>テキスト</label>
          <label class="chk"><input type="checkbox" id="c-choices" checked>選択項目</label>
          <label class="chk"><input type="checkbox" id="c-photos" checked>写真</label>
        </div>
        <button class="act" id="fill">この商品を流し込む</button>
        <div class="warn">流し込み後は必ず内容を確認してから、ご自身で出品ボタンを押してください。</div>
        <div class="log" id="log"></div>
        <button class="sub" id="inspect">フォーム構造をコピー(調整用)</button>
        <button class="sub" id="reload">商品リストを再読み込み</button>
        <div class="note" id="note"></div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  const logEl = $('#log');
  const noteEl = $('#note');

  const send = (msg) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || '不明なエラー'));
        resolve(res.data);
      });
    });

  function log(label, ok, detail = '') {
    const row = document.createElement('div');
    row.innerHTML = `<span class="${ok ? 'ok' : 'ng'}">${ok ? '✓' : '×'}</span>
      <span>${label}${detail ? ` <small>${detail}</small>` : ''}</span>`;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  $('#toggle').addEventListener('click', () => {
    const wrap = $('#wrap');
    wrap.classList.toggle('collapsed');
    $('#toggle').textContent = wrap.classList.contains('collapsed') ? '＋' : '－';
  });

  async function loadProducts() {
    const sel = $('#products');
    sel.innerHTML = '<option>読み込み中…</option>';
    try {
      const items = await send({ type: 'products' });
      if (!items.length) {
        sel.innerHTML = '<option value="">商品がありません</option>';
        return;
      }
      sel.innerHTML = items
        .map(
          (p) =>
            `<option value="${encodeURIComponent(p.slug)}">${p.name} — ¥${Number(p.price).toLocaleString()} (写真${p.photoCount})</option>`
        )
        .join('');
      noteEl.textContent = '';
    } catch (e) {
      sel.innerHTML = '<option value="">接続できません</option>';
      noteEl.textContent = `XW-3に接続できません(${e.message})。拡張のオプションでサーバURLを設定してください。`;
    }
  }

  async function toFiles(product) {
    const files = [];
    for (const name of product.photos) {
      const url = `/photos/${encodeURIComponent(product.slug)}/${encodeURIComponent(name)}`;
      const { base64, type } = await send({ type: 'photo', url });
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      files.push(new File([bytes], name, { type }));
    }
    return files;
  }

  $('#fill').addEventListener('click', async () => {
    const btn = $('#fill');
    const slugEnc = $('#products').value;
    if (!slugEnc) return;
    btn.disabled = true;
    logEl.innerHTML = '';
    try {
      const slug = decodeURIComponent(slugEnc);
      const product = await send({ type: 'product', slug });
      const listing = product.listing?.[site.id];
      if (!listing) throw new Error(`listing[${site.id}] がありません(サーバを更新してください)`);

      const wantPhotos = $('#c-photos').checked;
      let files = [];
      if (wantPhotos && product.photos.length) {
        log(`写真を取得中(${product.photos.length}枚)`, true);
        files = await toFiles(product);
      }

      const results = await window.XW3.fillForm(site, listing, files, {
        text: $('#c-text').checked,
        choices: $('#c-choices').checked,
        photos: wantPhotos,
      });

      logEl.innerHTML = '';
      for (const r of results) {
        log(r.label, r.ok, r.ok ? r.chosen || r.method || '' : r.reason || '');
      }
      const ng = results.filter((r) => !r.ok).length;
      log(ng ? `${ng}項目は手動で設定してください` : 'すべて入力しました', ng === 0);
    } catch (e) {
      log('エラー', false, e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#inspect').addEventListener('click', async () => {
    const dump = window.XW3.inspect();
    try {
      await navigator.clipboard.writeText(dump);
      noteEl.textContent = 'フォーム構造をクリップボードにコピーしました。';
    } catch {
      console.log('[XW-3] form structure:\n' + dump);
      noteEl.textContent = 'コピーできなかったのでDevToolsのConsoleに出力しました。';
    }
  });

  $('#reload').addEventListener('click', loadProducts);

  // 出品フォーム以外(出品トップ・商品ページ等)では流し込めないので明示する
  if (typeof site.isForm === 'function' && !site.isForm()) {
    $('#not-form').hidden = false;
  }

  loadProducts();
})();
