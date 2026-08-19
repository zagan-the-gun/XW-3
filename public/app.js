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
  // Yahoo!フリマの出品フォームは別ドメイン。/sell は出品トップなので直接フォームを開く
  yahoo: 'https://paypayfleamarket-sec.yahoo.co.jp/item/add?from=sellTop',
};

// サーバ側PHOTO_EXTSと同じ許可リスト(MIMEでなく拡張子で判定を揃える)
const PHOTO_EXT_RE = /\.(jpe?g|jfif|png|webp|gif|avif)$/i;

const state = { products: [], current: null, config: {}, choices: {}, filter: '' };

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

// ---------- 選択式フィールド ----------
// 出品ページ側がいずれも選択式(自由入力なし)なので、UIも閉じたプルダウンにする。
// 値の保持は input 側なので、保存処理は素の入力欄と同じ。

function choiceFieldHtml(inputId, options, value, note = '', emptyLabel = '(未設定)') {
  const opts = options || [];
  const known = opts.includes(value);
  // 一覧外の値(旧データからの移行など)も選択肢として出して気づけるようにする。黙って消さない
  const stray = !!value && !known;
  return `
    <div>
      <select data-choice-for="${inputId}">
        <option value=""${!value ? ' selected' : ''}>${esc(emptyLabel)}</option>
        ${opts.map((o) => `<option${known && o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}
        ${stray ? `<option selected>${esc(value)}</option>` : ''}
      </select>
      <input id="${inputId}" value="${esc(value)}" hidden>
      ${stray ? '<div class="field-note">現在の値は選択肢にありません。正しいものを選び直してください</div>' : ''}
      ${note ? `<div class="field-note">${esc(note)}</div>` : ''}
    </div>`;
}

// 発送に関する項目。以前は「共通設定」に分けていたが、どこで設定するのか
// 分かりにくかったため商品ごとの設定に統合した
const SHIP_FIELDS = [
  ['shipDays', '発送までの日数'],
  ['shippingPayer', '配送料の負担'],
  ['shipFrom', '発送元の地域'],
];

function shipFieldsHtml(site, p) {
  return SHIP_FIELDS.filter(([field]) => state.choices[site]?.[field])
    .map(
      ([field, name]) => `
        <label>${name}</label>
        ${choiceFieldHtml(
          `f-${site === 'mercari' ? 'm' : 'y'}-${field}`,
          state.choices[site][field],
          p.sites?.[site]?.[field] || ''
        )}`
    )
    .join('');
}

function shipValues(site) {
  const out = {};
  for (const [field] of SHIP_FIELDS) {
    const el = $(`#f-${site === 'mercari' ? 'm' : 'y'}-${field}`);
    if (el) out[field] = el.value;
  }
  return out;
}

function wireChoiceFields() {
  mainEl.querySelectorAll('[data-choice-for]').forEach((sel) => {
    const input = mainEl.querySelector(`#${sel.dataset.choiceFor}`);
    if (!input) return;
    sel.addEventListener('change', () => {
      input.value = sel.value;
    });
  });
}

// ---------- サイト別整形 ----------
// 整形済みの値(タイトル・タグ結合済み説明文など)はサーバの listing が唯一の生成元。
// Chrome拡張が流し込む値とコピーボタンの値を一致させるため、ここでは再計算しない。

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

// プルダウン選択用の行(コピーではなく「拡張が選ぶ値 / 手動時は見ながら選ぶ値」)
function pickRowHtml(label, value) {
  return `
    <div class="copy-row">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value) || '<span class="hint">(未設定)</span>'}</div>
      <div class="meta"><span class="hint">選択式</span></div>
    </div>`;
}

function renderDetail() {
  const p = state.current;
  const m = p.listing?.mercari || {};
  const y = p.listing?.yahoo || {};
  const mTitle = m.title || '';
  const mDesc = m.description || '';
  const yTitle = y.title || '';
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
      ${pickRowHtml('カテゴリ', m.category)}
      ${pickRowHtml('ブランド(任意)', m.brand)}
      ${pickRowHtml('商品の状態', m.condition)}
      ${pickRowHtml('配送の方法', m.shipping)}
      ${pickRowHtml('送料の負担', m.shippingPayer)}
      ${pickRowHtml('発送までの日数', m.shipDays)}
      ${pickRowHtml('発送元の地域', m.shipFrom)}
    </section>

    <section class="card">
      <h3>Yahoo!フリマ
        <a class="btn small link" href="${SELL_URLS.yahoo}" target="_blank" rel="noopener">出品ページを開く ↗</a>
      </h3>
      ${copyRowHtml('y-title', 'タイトル', yTitle, counterHtml(chars(yTitle), LIMITS.yahooTitle))}
      ${copyRowHtml('y-desc', '説明文(タグなし)', y.description || '', counterHtml(chars(y.description || ''), 0), true)}
      <div class="copy-row">
        <div class="label">タグ(専用欄・#なし)</div>
        <div class="value">
          <div class="tag-chips">
            ${tags.map((t) => `
              <span class="tag-chip ${chars(t) > LIMITS.yahooTagLen ? 'over' : ''}"
                    title="${chars(t)}文字">#${esc(t)}</span>`).join('') || '<span class="hint">(未設定)</span>'}
          </div>
        </div>
        <div class="meta">
          <button class="btn small" data-copy="y-tags">まとめてコピー</button>
          ${counterHtml(tags.length, LIMITS.yahooTagCount, '個')}
        </div>
      </div>
      ${copyRowHtml('y-price', '価格', String(p.price))}
      ${pickRowHtml('カテゴリ', y.category)}
      ${pickRowHtml('商品の状態', y.condition)}
      ${pickRowHtml('配送方法', y.shipping)}
      ${pickRowHtml('発送までの日数', y.shipDays)}
      ${pickRowHtml('発送元の地域', y.shipFrom)}
      <div class="copy-row">
        <div class="label">送料</div>
        <div class="value"><span class="hint">全商品が出品者負担・全国一律・匿名配送で固定(選択項目なし)</span></div>
        <div class="meta"></div>
      </div>
    </section>

    <section class="card">
      <h3>自分用メモ<span class="hint">出品フォームには入りません</span></h3>
      <dl class="memo-grid">
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
    'y-desc': () => y.description || '',
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
    ? { name: '', price: 0, title: '', description: '', tags: [], brand: '', notes: '',
        sites: {
          mercari: { title: '', category: '', condition: '新品、未使用', shipping: '' },
          yahoo: { title: '', category: '', condition: '新品、未使用', shipping: '' },
        } }
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
        <div><input id="f-tags" value="${esc((p.tags || []).map((t) => `#${t}`).join(' '))}" placeholder="#ハンドメイド #ピアス (#付き・スペース区切り)">
          <div class="field-note">メルカリ→説明文末尾にそのまま結合 / Yahoo→専用欄用に#なしでコピー(30文字×20個まで)</div></div>
        <label>ブランド</label>
        <div><input id="f-brand" value="${esc(p.brand || '')}" placeholder="DAIWA(任意・空ならスキップ)">
          <div class="field-note">メルカリのみ(Yahoo!フリマにブランド項目はありません)。出品ページの検索欄に入力して候補から選ばれます</div></div>
        <label>メモ</label>
        <div><input id="f-notes" value="${esc(p.notes)}" placeholder="自分用(原価・梱包資材・在庫場所など)">
          <div class="field-note">出品フォームには入りません</div></div>
      </div>

      <h3 style="margin:18px 0 12px">メルカリの選択項目
        <span class="hint">拡張がこの文言で選択します。画面の表記そのままで入力</span>
      </h3>
      <div class="form-grid">
        <label>カテゴリー</label>
        <div><input id="f-m-category" value="${esc(p.sites?.mercari?.category || '')}" placeholder="ハンドメイド・手芸 > 雑貨・ステーショナリー > ブックカバー">
          <div class="field-note">階層は「&gt;」で区切る(上位から順に選択されます)。区切り以外の「・」はカテゴリ名の一部</div></div>
        <label>商品の状態</label>
        ${choiceFieldHtml('f-m-condition', state.choices.mercari?.condition, p.sites?.mercari?.condition || '')}
        <label>配送の方法</label>
        ${choiceFieldHtml('f-m-shipping', state.choices.mercari?.shipping, p.sites?.mercari?.shipping || '')}
        ${shipFieldsHtml('mercari', p)}
      </div>

      <h3 style="margin:18px 0 12px">Yahoo!フリマの選択項目</h3>
      <div class="form-grid">
        <label>カテゴリ</label>
        <div><input id="f-y-category" value="${esc(p.sites?.yahoo?.category || '')}" placeholder="アウトドア、釣り、旅行用品 > 釣り > その他釣り具">
          <div class="field-note">メルカリとはカテゴリ体系も区切り文字も違います(こちらは「、」)</div></div>
        <label>商品の状態</label>
        ${choiceFieldHtml('f-y-condition', state.choices.yahoo?.condition, p.sites?.yahoo?.condition || '',
          '5段階。メルカリと違い「新品、」は付きません')}
        <label>配送方法</label>
        ${choiceFieldHtml('f-y-shipping', state.choices.yahoo?.shipping, p.sites?.yahoo?.shipping || '')}
        ${shipFieldsHtml('yahoo', p)}
      </div>
      <div class="form-actions">
        <button class="btn primary" id="btn-save">保存</button>
        <button class="btn" id="btn-cancel">キャンセル</button>
      </div>
    </section>
  `;

  wireChoiceFields();

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
      brand: $('#f-brand').value,
      notes: $('#f-notes').value,
      sites: {
        mercari: {
          title: $('#f-m-title').value,
          category: $('#f-m-category').value,
          condition: $('#f-m-condition').value,
          shipping: $('#f-m-shipping').value,
          ...shipValues('mercari'),
        },
        yahoo: {
          title: $('#f-y-title').value,
          category: $('#f-y-category').value,
          condition: $('#f-y-condition').value,
          shipping: $('#f-y-shipping').value,
          ...shipValues('yahoo'),
        },
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
  state.choices = await api('/api/choices').catch(() => ({}));
  await loadProducts(false);
  if (state.products.length > 0) openProduct(state.products[0].slug);
})().catch((e) => toast(`読み込み失敗: ${e.message}`));
