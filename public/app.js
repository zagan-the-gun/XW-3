'use strict';

// サイト別の入力制限(2026-08時点の調査値。READMEに出典あり)
const LIMITS = {
  mercariTitle: 40,
  mercariDesc: 1000,
  yahooTitle: 65,
  yahooTagLen: 30,
  yahooTagCount: 20,
};

const SELL_URLS = {
  mercari: 'https://jp.mercari.com/sell/create',
  yahoo: 'https://paypayfleamarket.yahoo.co.jp/sell',
};

// サーバ側PHOTO_EXTSと同じ許可リスト(MIMEでなく拡張子で判定を揃える)
const PHOTO_EXT_RE = /\.(jpe?g|jfif|png|webp|gif|avif)$/i;

const state = { products: [], current: null, config: {}, filter: '' };

const $ = (sel, el = document) => el.querySelector(sel);
const listEl = $('#product-list');
const mainEl = $('#main');

// ---------- ユーティリティ ----------

function chars(s) {
  return [...String(s || '')].length; // コードポイント数(サロゲートペア対応)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body && !(options.body instanceof Blob) && !(options.body instanceof File)
      ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return res.json();
}

// LAN上のhttp(非セキュアコンテキスト)ではnavigator.clipboardが使えないため
// execCommandへフォールバックする
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('コピーに失敗しました');
}

// 破壊的操作の多重実行防止(実行中の連打・二重クリックを無視)+失敗トースト
let busy = false;
function guard(label, fn) {
  return async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await fn(...args);
    } catch (e) {
      toast(`${label}: ${e.message}`);
    } finally {
      busy = false;
    }
  };
}

function wireCopyButton(btn, getText) {
  btn.addEventListener('click', async () => {
    try {
      await copyText(getText());
      const original = btn.textContent;
      btn.textContent = '✓ コピーしました';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1500);
    } catch (e) {
      toast(`コピー失敗: ${e.message}`);
    }
  });
}

// ---------- サイト別整形 ----------

function mercariTitle(p) {
  return p.sites?.mercari?.title || p.title || '';
}

function yahooTitle(p) {
  return p.sites?.yahoo?.title || p.title || '';
}

// メルカリはハッシュタグ専用欄がなく説明文内に「#タグ」を書く方式
function mercariDescription(p) {
  const tags = (p.tags || []).map((t) => `#${t}`).join(' ');
  const desc = p.description || '';
  return tags ? `${desc}\n\n${tags}` : desc;
}

function photoUrl(slug, file) {
  return `/photos/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

// ---------- 商品リスト ----------

async function loadProducts(keepCurrent = true) {
  state.products = await api('/api/products');
  renderList();
  if (keepCurrent && state.current) {
    const still = state.products.find((p) => p.slug === state.current.slug);
    if (!still) {
      state.current = null;
      mainEl.innerHTML = '<div class="empty">左のリストから商品を選択してください</div>';
    }
  }
}

function renderList() {
  const filter = state.filter.trim();
  const items = state.products.filter((p) => !filter || String(p.name || '').includes(filter));
  listEl.innerHTML = items.map((p) => `
    <div class="product-item ${state.current?.slug === p.slug ? 'active' : ''}" data-slug="${esc(p.slug)}">
      ${p.photo
        ? `<img class="thumb" src="${esc(p.photo)}" alt="">`
        : '<div class="thumb placeholder">📷</div>'}
      <div class="info">
        <div class="name">${esc(p.name)}</div>
        <div class="sub">¥${Number(p.price || 0).toLocaleString()} ・ 写真${p.photoCount}枚</div>
      </div>
    </div>
  `).join('') || '<div class="empty">商品がありません</div>';

  listEl.querySelectorAll('.product-item').forEach((el) => {
    el.addEventListener('click', () => openProduct(el.dataset.slug));
  });
}

// ---------- 詳細表示 ----------

let openSeq = 0;
async function openProduct(slug) {
  const seq = ++openSeq;
  let product;
  try {
    product = await api(`/api/products/${encodeURIComponent(slug)}`);
  } catch (e) {
    toast(`読み込み失敗: ${e.message}`);
    return;
  }
  if (seq !== openSeq) return; // 素早い商品切り替え時、後着の古いレスポンスは破棄
  state.current = product;
  renderList();
  renderDetail();
}

function counterHtml(n, limit, suffix = '') {
  const over = limit && n > limit;
  return `<span class="counter ${over ? 'over' : ''}">${n}${limit ? `/${limit}` : ''}${suffix}</span>`;
}

function copyRowHtml(id, label, value, counter = '', clamp = false) {
  return `
    <div class="copy-row">
      <div class="label">${esc(label)}</div>
      <div class="value ${clamp ? 'clamp' : ''}">${esc(value) || '<span class="hint">(未設定)</span>'}</div>
      <div class="meta">
        <button class="btn small" data-copy="${id}">コピー</button>
        ${counter}
      </div>
    </div>`;
}

function renderDetail() {
  const p = state.current;
  const mTitle = mercariTitle(p);
  const mDesc = mercariDescription(p);
  const yTitle = yahooTitle(p);
  const tags = p.tags || [];
  const folderPath = (state.config.photoPathPrefix || state.config.productsDir || '') +
    `/${p.slug}/photos`;

  mainEl.innerHTML = `
    <div class="detail-head">
      <h2>${esc(p.name)}</h2>
      <span class="price">¥${Number(p.price).toLocaleString()}</span>
    </div>
    <div class="detail-actions">
      <button class="btn" id="btn-edit">✏️ 編集</button>
      <button class="btn" id="btn-duplicate">📄 複製して新規</button>
      <button class="btn danger" id="btn-delete">🗑 削除</button>
    </div>

    <section class="card">
      <h3>写真(${p.photos.length}枚)
        <span class="hint">サムネイルを出品フォームへ直接ドラッグできます(1枚ずつ・Chrome)。まとめて入れる場合はフォルダから全選択してドラッグ。</span>
      </h3>
      <div class="photo-grid">
        ${p.photos.map((f, i) => `
          <div class="photo" data-file="${esc(f)}">
            <!-- srcは原寸ファイル。別ファイルのサムネイルにするとドラッグで運ばれるのが縮小版になる -->
            <img src="${photoUrl(p.slug, f)}" draggable="true" alt="${esc(f)}"
                 title="出品フォームへドラッグできます">
            <span class="num">${i + 1}</span>
            <div class="photo-actions">
              <button data-move="-1" title="前へ">←</button>
              <button class="del" data-del title="削除">×</button>
              <button data-move="1" title="次へ">→</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="dropzone" id="dropzone">ここに画像をドロップ、またはクリックして追加(掲載順に連番で保存されます)</div>
      <input type="file" id="file-input" accept=".jpg,.jpeg,.jfif,.png,.webp,.gif,.avif" multiple hidden>
      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn small" id="btn-copy-folder">📁 写真フォルダのパスをコピー</button>
        <span class="hint">Finderで ⌘⇧G →ペーストで開けます(SMBマウント時はPHOTO_PATH_PREFIXを設定)</span>
      </div>
    </section>

    <section class="card">
      <h3>メルカリ
        <a class="btn small link" href="${SELL_URLS.mercari}" target="_blank" rel="noopener">出品ページを開く ↗</a>
      </h3>
      ${copyRowHtml('m-title', 'タイトル', mTitle, counterHtml(chars(mTitle), LIMITS.mercariTitle))}
      ${copyRowHtml('m-desc', '説明文(タグ込み)', mDesc, counterHtml(chars(mDesc), LIMITS.mercariDesc), true)}
      ${copyRowHtml('m-price', '価格', String(p.price))}
    </section>

    <section class="card">
      <h3>Yahoo!フリマ
        <a class="btn small link" href="${SELL_URLS.yahoo}" target="_blank" rel="noopener">出品ページを開く ↗</a>
      </h3>
      ${copyRowHtml('y-title', 'タイトル', yTitle, counterHtml(chars(yTitle), LIMITS.yahooTitle))}
      ${copyRowHtml('y-desc', '説明文(タグなし)', p.description || '', counterHtml(chars(p.description || ''), 0), true)}
      <div class="copy-row">
        <div class="label">タグ(専用欄)</div>
        <div class="value">
          <div class="tag-chips">
            ${tags.map((t) => `
              <span class="tag-chip ${chars(t) > LIMITS.yahooTagLen ? 'over' : ''}"
                    title="${chars(t)}文字">${esc(t)}</span>`).join('') || '<span class="hint">(未設定)</span>'}
          </div>
        </div>
        <div class="meta">
          <button class="btn small" data-copy="y-tags">まとめてコピー</button>
          ${counterHtml(tags.length, LIMITS.yahooTagCount, '個')}
        </div>
      </div>
      ${copyRowHtml('y-price', '価格', String(p.price))}
    </section>

    <section class="card">
      <h3>出品メモ</h3>
      <dl class="memo-grid">
        <dt>商品の状態</dt><dd>${esc(p.condition) || '-'}</dd>
        <dt>カテゴリ</dt><dd>${esc(p.categoryMemo) || '-'}</dd>
        <dt>配送</dt><dd>${esc(p.shippingMemo) || '-'}</dd>
        <dt>メモ</dt><dd>${esc(p.notes) || '-'}</dd>
      </dl>
    </section>
  `;

  // コピーボタン
  const copySources = {
    'm-title': () => mTitle,
    'm-desc': () => mDesc,
    'm-price': () => String(p.price),
    'y-title': () => yTitle,
    'y-desc': () => p.description || '',
    'y-tags': () => tags.join(' '),
    'y-price': () => String(p.price),
  };
  mainEl.querySelectorAll('[data-copy]').forEach((btn) => {
    wireCopyButton(btn, copySources[btn.dataset.copy]);
  });
  wireCopyButton($('#btn-copy-folder'), () => folderPath);

  // ヘッダ操作
  $('#btn-edit').addEventListener('click', () => renderEditForm());
  $('#btn-duplicate').addEventListener('click', guard('複製失敗', async () => {
    const created = await api(`/api/products/${encodeURIComponent(p.slug)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name: `${p.name} (コピー)` }),
    });
    await loadProducts();
    await openProduct(created.slug);
    toast('複製しました');
  }));
  $('#btn-delete').addEventListener('click', guard('削除失敗', async () => {
    if (!confirm(`「${p.name}」を削除しますか?(データはtrashフォルダに移動されます)`)) return;
    await api(`/api/products/${encodeURIComponent(p.slug)}`, { method: 'DELETE' });
    state.current = null;
    await loadProducts();
    mainEl.innerHTML = '<div class="empty">削除しました(復元はdata/trashから)</div>';
  }));

  // 写真操作
  // guard()の多重実行防止が古いDOMからの連打を弾き、成功後のopenProductで
  // DOMごと作り直されるため、描画時点のp.photosクロージャが古くなる問題も解消される
  mainEl.querySelectorAll('.photo [data-move]').forEach((btn) => {
    btn.addEventListener('click', guard('並べ替え失敗', async () => {
      const file = btn.closest('.photo').dataset.file;
      const dir = parseInt(btn.dataset.move, 10);
      const order = [...p.photos];
      const i = order.indexOf(file);
      const j = i + dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      try {
        await api(`/api/products/${encodeURIComponent(p.slug)}/photos/reorder`, {
          method: 'POST',
          body: JSON.stringify({ order }),
        });
      } finally {
        await openProduct(p.slug); // 失敗時もサーバの実状態に再同期する
      }
    }));
  });
  mainEl.querySelectorAll('.photo [data-del]').forEach((btn) => {
    btn.addEventListener('click', guard('写真の削除失敗', async () => {
      const file = btn.closest('.photo').dataset.file;
      if (!confirm(`${file} を削除しますか?`)) return;
      await api(`/api/products/${encodeURIComponent(p.slug)}/photos/${encodeURIComponent(file)}`, {
        method: 'DELETE',
      });
      await openProduct(p.slug);
      await loadProducts();
    }));
  });

  // アップロード
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    uploadFiles(e.dataTransfer.files);
  });

  async function uploadFiles(fileList) {
    const all = [...fileList];
    const files = all.filter((f) => PHOTO_EXT_RE.test(f.name));
    const skipped = all.filter((f) => !PHOTO_EXT_RE.test(f.name));
    if (files.length === 0) {
      if (all.length > 0) {
        toast('対応していない形式です(jpg/png/webp/gif/avif。iPhoneのHEICはJPEGに変換してください)');
      }
      return;
    }
    toast(`${files.length}枚アップロード中…`);
    const failed = [];
    for (const f of files) {
      try {
        await api(
          `/api/products/${encodeURIComponent(p.slug)}/photos?name=${encodeURIComponent(f.name)}`,
          { method: 'PUT', body: f }
        );
      } catch (e) {
        failed.push(`${f.name}: ${e.message}`);
      }
    }
    fileInput.value = ''; // 同じファイルの選び直しでchangeが発火するようリセット
    await openProduct(p.slug); // 部分成功も必ず画面に反映
    await loadProducts().catch(() => {});
    const ok = files.length - failed.length;
    if (failed.length > 0 || skipped.length > 0) {
      toast(`${ok}枚追加 / ${failed.length + skipped.length}件は失敗・非対応${failed[0] ? ` (${failed[0]})` : ''}`);
    } else {
      toast(`${ok}枚追加しました`);
    }
  }
}

// ---------- 編集フォーム ----------

function renderEditForm(isNew = false) {
  const p = isNew
    ? { name: '', price: 0, title: '', description: '', tags: [], condition: '新品、未使用',
        categoryMemo: '', shippingMemo: '', notes: '', sites: { mercari: { title: '' }, yahoo: { title: '' } } }
    : state.current;

  mainEl.innerHTML = `
    <div class="detail-head"><h2>${isNew ? '新規商品' : `${esc(p.name)} を編集`}</h2></div>
    <section class="card">
      <div class="form-grid">
        <label>商品名(管理用)</label>
        <div><input id="f-name" value="${esc(p.name)}" placeholder="例: 花ピアス(青)">
          <div class="field-note">フォルダ名になります(あとから変えてもフォルダ名は変わりません)</div></div>
        <label>価格(円)</label>
        <div><input id="f-price" type="number" min="0" value="${esc(p.price)}"></div>
        <label>共通タイトル</label>
        <div><input id="f-title" value="${esc(p.title)}">
          <div class="field-note">メルカリ40文字 / Yahoo!フリマ65文字。下の個別欄が空ならこれを使用</div></div>
        <label>メルカリ用タイトル</label>
        <div><input id="f-m-title" value="${esc(p.sites?.mercari?.title || '')}" placeholder="(共通タイトルを使う場合は空)"></div>
        <label>Yahoo用タイトル</label>
        <div><input id="f-y-title" value="${esc(p.sites?.yahoo?.title || '')}" placeholder="(共通タイトルを使う場合は空)"></div>
        <label>説明文</label>
        <div><textarea id="f-desc">${esc(p.description)}</textarea>
          <div class="field-note">ハッシュタグは書かないでください(メルカリ用コピーで自動的に末尾へ付きます)</div></div>
        <label>タグ</label>
        <div><input id="f-tags" value="${esc((p.tags || []).join(' '))}" placeholder="スペース区切り。#は不要">
          <div class="field-note">メルカリ→説明文末尾に#付きで結合 / Yahoo→専用欄用(30文字×20個まで)</div></div>
        <label>商品の状態</label>
        <div><input id="f-condition" value="${esc(p.condition)}" placeholder="例: 新品、未使用"></div>
        <label>カテゴリメモ</label>
        <div><input id="f-category" value="${esc(p.categoryMemo)}" placeholder="例: ハンドメイド > アクセサリー > ピアス"></div>
        <label>配送メモ</label>
        <div><input id="f-shipping" value="${esc(p.shippingMemo)}" placeholder="例: ゆうゆうメルカリ便 / プチプチ+封筒"></div>
        <label>メモ</label>
        <div><input id="f-notes" value="${esc(p.notes)}"></div>
      </div>
      <div class="form-actions">
        <button class="btn primary" id="btn-save">保存</button>
        <button class="btn" id="btn-cancel">キャンセル</button>
      </div>
    </section>
  `;

  $('#btn-cancel').addEventListener('click', () => {
    if (isNew) {
      mainEl.innerHTML = '<div class="empty">左のリストから商品を選択してください</div>';
    } else {
      renderDetail();
    }
  });

  $('#btn-save').addEventListener('click', guard('保存失敗', async () => {
    const body = {
      name: $('#f-name').value,
      price: Number($('#f-price').value || 0),
      title: $('#f-title').value,
      description: $('#f-desc').value,
      tags: $('#f-tags').value.split(/[\s,、]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
      condition: $('#f-condition').value,
      categoryMemo: $('#f-category').value,
      shippingMemo: $('#f-shipping').value,
      notes: $('#f-notes').value,
      sites: {
        mercari: { title: $('#f-m-title').value },
        yahoo: { title: $('#f-y-title').value },
      },
    };
    const saved = isNew
      ? await api('/api/products', { method: 'POST', body: JSON.stringify(body) })
      : await api(`/api/products/${encodeURIComponent(state.current.slug)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
    await loadProducts();
    await openProduct(saved.slug);
    toast('保存しました');
  }));
}

// ---------- 初期化 ----------

$('#btn-new').addEventListener('click', () => {
  state.current = null;
  renderList();
  renderEditForm(true);
});

$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderList();
});

// ドロップゾーンを外した誤ドロップでページが画像ファイルに置き換わるのを防ぐ
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('unhandledrejection', (e) => {
  toast(`エラー: ${e.reason?.message || e.reason}`);
});

(async () => {
  state.config = await api('/api/config').catch(() => ({}));
  await loadProducts(false);
  if (state.products.length > 0) openProduct(state.products[0].slug);
})().catch((e) => toast(`読み込み失敗: ${e.message}`));
