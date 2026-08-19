'use strict';

// XW-3 出品くん — フォーム流し込みエンジン
//
// 設計方針:
// - chrome.* APIには依存しない(test/mock-*.html から素の<script>で読み込んで検証できるように)
// - メルカリ/Yahoo!フリマのDOMは予告なく変わるためCSSセレクタ決め打ちを避け、
//   「画面のラベル文字列から入力欄を辿る」方式を主軸にする
// - 埋められなかった項目は例外にせず結果として返し、UIで人間に伝える
//   (出品ボタンは押さないので、最終確認は必ず人間が行う前提)

window.XW3 = window.XW3 || {};

(() => {
  const sites = [];

  const TEXT_SEL =
    'input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable="true"]';
  const CHOICE_SEL =
    'select, [role="combobox"], [role="listbox"], button, [role="button"], [aria-haspopup], input[readonly]';
  const OPTION_SELS = [
    '[role="option"]',
    '[role="menuitem"]',
    '[role="listbox"] li',
    'ul[class*="option"] li',
    'li[class*="option"]',
    '[class*="dropdown"] li',
    '[class*="menu"] li',
    '[class*="modal"] li',
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- テキスト正規化 ----------
  // 全角/半角・空白・括弧・読点の差を吸収して比較する(サイト表記の揺れ対策)
  function norm(s) {
    return String(s ?? '')
      .normalize('NFKC')
      .replace(/[\s　]+/g, '')
      .replace(/[（）()「」『』［］[\]【】]/g, '')
      .replace(/[、,。.･・]/g, '')
      .replace(/[〜～~]/g, '~')
      .toLowerCase();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  // 直下のテキストノードのみ(親コンテナの長文が誤マッチするのを防ぐ)
  function ownText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue;
    }
    return out.trim();
  }

  // ---------- 候補文字列のスコアリング ----------
  function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  function score(candidate, wanted) {
    const a = norm(candidate);
    const b = norm(wanted);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.startsWith(b) || b.startsWith(a)) return 85;
    if (a.includes(b)) return 72;
    if (b.includes(a)) return 66;
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const g of A) if (B.has(g)) hit += 1;
    return Math.round((50 * hit) / Math.max(A.size, B.size));
  }

  const MATCH_THRESHOLD = 60;

  function pickBest(texts, wanted) {
    let best = null;
    texts.forEach((t, index) => {
      const s = score(t, wanted);
      if (!best || s > best.score) best = { index, score: s, text: String(t).trim() };
    });
    return best && best.score >= MATCH_THRESHOLD ? best : null;
  }

  // ---------- 値の書き込み ----------
  // Reactは内部のvalueTrackerで変更を判定するため、prototypeのsetter経由で書く
  function setNativeValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, type, EventCtor = Event) {
    el.dispatchEvent(new EventCtor(type, { bubbles: true }));
  }

  async function fillText(el, value) {
    if (!el) return { ok: false, reason: '入力欄が見つかりません' };
    const text = String(value ?? '');
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return { ok: el.textContent === text, value: text };
    }
    // 既存値を消してから入れる(サイト側の「変化なし」判定を回避)
    setNativeValue(el, '');
    fire(el, 'input');
    setNativeValue(el, text);
    fire(el, 'input');
    fire(el, 'change');
    await sleep(30);
    const got = el.value;
    // 数値欄などサイト側が整形する場合があるため、数字だけ比較して許容する
    const ok = got === text || norm(got) === norm(text) ||
      got.replace(/[^\d]/g, '') === text.replace(/[^\d]/g, '');
    return { ok, value: got, reason: ok ? '' : `入力後の値が一致しません(${got})` };
  }

  // ---------- 選択式(select / ラジオ / カスタムUI) ----------
  function chooseInSelect(sel, wanted) {
    const options = [...sel.options].filter((o) => o.value !== '' && !o.disabled);
    if (!options.length) return { ok: false, reason: '選択肢が空です' };
    const best = pickBest(options.map((o) => o.textContent), wanted);
    if (!best) {
      return {
        ok: false,
        reason: `該当なし(候補: ${options.slice(0, 6).map((o) => o.textContent.trim()).join(' / ')})`,
      };
    }
    setNativeValue(sel, options[best.index].value);
    fire(sel, 'input');
    fire(sel, 'change');
    return { ok: true, chosen: best.text, score: best.score };
  }

  function radioLabel(radio) {
    if (radio.getAttribute('aria-label')) return radio.getAttribute('aria-label');
    if (radio.id) {
      const l = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (l) return l.textContent;
    }
    const wrap = radio.closest('label');
    if (wrap) return wrap.textContent;
    const sib = radio.nextElementSibling;
    if (sib) return sib.textContent;
    return radio.value || '';
  }

  function chooseInRadios(radios, wanted) {
    const best = pickBest(radios.map(radioLabel), wanted);
    if (!best) {
      return {
        ok: false,
        reason: `該当なし(候補: ${radios.slice(0, 6).map((r) => radioLabel(r).trim()).join(' / ')})`,
      };
    }
    radios[best.index].click();
    return { ok: true, chosen: best.text, score: best.score };
  }

  function collectOptionNodes(root = document) {
    for (const s of OPTION_SELS) {
      const nodes = [...root.querySelectorAll(s)].filter(isVisible);
      if (nodes.length) return nodes;
    }
    return [];
  }

  async function chooseInCustom(trigger, wanted) {
    trigger.click();
    let nodes = [];
    for (let i = 0; i < 15 && nodes.length === 0; i++) {
      await sleep(100);
      nodes = collectOptionNodes();
    }
    if (!nodes.length) return { ok: false, reason: '選択肢が開きませんでした(手動で選んでください)' };
    const best = pickBest(nodes.map((n) => n.textContent), wanted);
    if (!best) {
      const sample = nodes.slice(0, 6).map((n) => n.textContent.trim().slice(0, 20)).join(' / ');
      document.body.click();
      return { ok: false, reason: `該当なし(候補: ${sample})` };
    }
    nodes[best.index].click();
    await sleep(150);
    return { ok: true, chosen: best.text.slice(0, 40), score: best.score };
  }

  function triggerIn(block) {
    if (!block) return null;
    if (block.matches?.('[role="combobox"], [aria-haspopup], button, [role="button"], input[readonly]')) return block;
    return (
      [...block.querySelectorAll('[role="combobox"], [aria-haspopup], button, [role="button"], input[readonly]')]
        .find(isVisible) || null
    );
  }

  // 既に選択肢が開いていればそこから選び、開いていなければトリガーを押してから選ぶ
  // (階層カテゴリは1段目を選ぶと同じモーダル内に2段目が出る作りが多い)
  async function chooseCustomStep(block, wanted) {
    const open = collectOptionNodes();
    if (open.length) {
      const best = pickBest(open.map((n) => n.textContent), wanted);
      if (best) {
        open[best.index].click();
        await sleep(200);
        return { ok: true, chosen: best.text.slice(0, 40), score: best.score };
      }
    }
    const trigger = triggerIn(block);
    if (!trigger) return { ok: false, reason: '選択UIを特定できません' };
    return chooseInCustom(trigger, wanted);
  }

  // 階層カテゴリで使うscope。block自身がselectの場合は兄弟のselectを見るため親へ上がる
  function cascadeScope(block, want) {
    if (!block) return null;
    let scope = block.tagName === 'SELECT' ? block.parentElement : block;
    for (let d = 0; d < 3 && scope && scope.tagName !== 'BODY'; d += 1) {
      const n = [...scope.querySelectorAll('select')].filter(isVisible).length;
      if (n >= Math.min(want, 2)) return scope;
      scope = scope.parentElement;
    }
    return block.tagName === 'SELECT' ? block.parentElement || block : block;
  }

  // 階層カテゴリ: ネイティブselectなら i 段目、カスタムUIなら開いている選択肢から順に選ぶ
  async function chooseCascade(blockOrSelect, parts) {
    const out = [];
    const block = cascadeScope(blockOrSelect, parts.length);
    for (let i = 0; i < parts.length; i += 1) {
      const selects = block ? [...block.querySelectorAll('select')].filter(isVisible) : [];
      let r;
      if (selects.length > 1 || (selects.length === 1 && i === 0)) {
        r = selects[i]
          ? chooseInSelect(selects[i], parts[i])
          : { ok: false, reason: `${i + 1}階層目のプルダウンが現れませんでした` };
      } else {
        r = await chooseCustomStep(block, parts[i]);
      }
      out.push({ part: parts[i], ...r });
      if (!r.ok) break;
      await sleep(400);
    }
    return out;
  }

  // ブロック内の選択UIの種類を見分けて選ぶ
  async function chooseInBlock(block, wanted) {
    if (!block) return { ok: false, reason: '項目が見つかりません' };
    if (block.tagName === 'SELECT') return chooseInSelect(block, wanted);

    const sel = [...block.querySelectorAll('select')].find(isVisible);
    if (sel) return chooseInSelect(sel, wanted);

    const radios = [...block.querySelectorAll('input[type="radio"]')];
    if (radios.length) return chooseInRadios(radios, wanted);

    const trigger =
      [...block.querySelectorAll('[role="combobox"], [aria-haspopup], button, [role="button"], input[readonly]')]
        .find(isVisible) || (isVisible(block) ? block : null);
    if (trigger) return chooseInCustom(trigger, wanted);
    return { ok: false, reason: '選択UIを特定できません' };
  }

  // ---------- ラベルから入力欄を探す ----------
  function labelNodes(text, root = document) {
    const t = norm(text);
    if (!t) return [];
    const out = [];
    for (const el of root.querySelectorAll('label, legend, h1, h2, h3, h4, h5, span, div, p, dt, th, b, strong')) {
      if (!isVisible(el)) continue;
      const own = ownText(el);
      if (!own || own.length > 40) continue;
      const n = norm(own);
      if (!n) continue;
      // ラベル文字列と概ね同じ長さのものだけ(長文に埋もれた一致を除外)
      const hit = n === t || n.startsWith(t) || (t.length >= 3 && n.includes(t));
      if (hit && n.length <= t.length + 10) out.push(el);
    }
    return out;
  }

  function controlsIn(el, selector) {
    if (!el || el.nodeType !== 1) return [];
    const found = [];
    if (el.matches?.(selector) && isVisible(el)) found.push(el);
    for (const c of el.querySelectorAll(selector)) {
      if (isVisible(c)) found.push(c);
    }
    return found;
  }

  // ラベルより後ろにあるコントロールを優先する(前方の別項目を掴まないため)
  function orderedControls(scope, selector, afterEl) {
    const all = controlsIn(scope, selector).filter((c) => c !== afterEl);
    if (!afterEl) return all;
    const following = all.filter(
      (c) => afterEl.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    return following.length ? following : all;
  }

  // ラベル要素から対応する入力欄を辿る。
  // 兄弟方向を無制限に走査すると隣の項目の入力欄を掴むため、
  // 「祖先を1段ずつ広げながらその内部だけを見る」方式にしている。
  function resolveFromLabel(labelEl, selector) {
    if (labelEl.tagName === 'LABEL') {
      const id = labelEl.getAttribute('for');
      if (id) {
        const el = document.getElementById(id);
        if (el && el.matches(selector) && isVisible(el)) return el;
      }
    }
    let node = labelEl;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
      const found = orderedControls(node, selector, labelEl);
      if (found.length) return found[0];
      node = node.parentElement;
    }
    return null;
  }

  function findField(spec, root = document) {
    const selector = spec.kind === 'choice' ? CHOICE_SEL : TEXT_SEL;

    for (const sel of spec.selectors || []) {
      const el = [...root.querySelectorAll(sel)].find(isVisible);
      if (el) return el;
    }
    for (const label of spec.labels || []) {
      for (const node of labelNodes(label, root)) {
        const el = resolveFromLabel(node, selector);
        if (el) return el;
      }
    }
    for (const ph of spec.placeholders || []) {
      const el = [...root.querySelectorAll('input, textarea')].find(
        (e) => isVisible(e) && e.placeholder && norm(e.placeholder).includes(norm(ph))
      );
      if (el) return el;
    }
    for (const name of spec.names || []) {
      const el = [...root.querySelectorAll(`[name="${CSS.escape(name)}"]`)].find(isVisible);
      if (el) return el;
    }
    for (const aria of spec.labels || []) {
      const el = [...root.querySelectorAll('[aria-label]')].find(
        (e) => isVisible(e) && e.matches(selector) && norm(e.getAttribute('aria-label')).includes(norm(aria))
      );
      if (el) return el;
    }
    return null;
  }

  // 選択式の項目を探す。
  // 祖先を1段ずつ広げ、最初に見つかった選択UIを返す(ラジオ群 > select > カスタム)。
  // 複数のselectがある場合は階層カテゴリなのでコンテナごと返す。
  function findChoiceBlock(spec, root = document) {
    for (const sel of spec.selectors || []) {
      const el = [...root.querySelectorAll(sel)].find(isVisible);
      if (el) return el;
    }
    for (const label of spec.labels || []) {
      for (const node of labelNodes(label, root)) {
        let cur = node;
        for (let depth = 0; depth < 4 && cur; depth += 1) {
          if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;

          const radios = [...cur.querySelectorAll('input[type="radio"]')].filter(isVisible);
          if (radios.length > 1) return cur;

          const selects = orderedControls(cur, 'select', node);
          // 広すぎる祖先(ページ全体)を掴んだ場合は打ち切る
          if (selects.length > 6) break;
          if (selects.length > 1) return cur;
          if (selects.length === 1) return selects[0];

          const triggers = orderedControls(
            cur,
            '[role="combobox"], [aria-haspopup], input[readonly], button, [role="button"]',
            node
          );
          if (triggers.length) return cur;

          cur = cur.parentElement;
        }
      }
    }
    return null;
  }

  // ---------- 別ページで選ぶ項目(メルカリのカテゴリー/状態/配送の方法) ----------
  // メルカリはこの3項目がフォーム内のプルダウンではなく専用ページへの遷移になっている
  // (/sell/categories など)。SPAのクライアント遷移なので入力済みの内容は保持される。

  async function waitFor(fn, timeout = 4000, interval = 120) {
    const limit = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > limit) return null;
      await sleep(interval);
    }
  }

  function clickableCandidates(root = document) {
    return [...root.querySelectorAll('a, button, [role="button"], [role="option"], [role="menuitem"], li, label')]
      .filter((el) => {
        if (!isVisible(el)) return false;
        const t = el.textContent.trim();
        return t && t.length <= 30;
      });
  }

  // 行はリンク(<a>)のこともプレーンなdivのこともあるため、
  // 文字列が一致した要素の「クリックできそうな親」まで遡ってクリックする
  const ROW_SEL = 'a, button, [role="button"], li, [class*="row"], [class*="Row"], [tabindex]';

  async function openSelectionPage(spec) {
    // 「カテゴリーを選択する」のような文言を持つ行
    for (const t of spec.openTexts || []) {
      for (const node of labelNodes(t)) {
        (node.closest(ROW_SEL) || node).click();
        return true;
      }
    }
    // ラベル行から辿る(すでに値が入っていて openText が出ていない場合など)
    for (const label of spec.labels || []) {
      for (const node of labelNodes(label)) {
        const clickable = node.closest(ROW_SEL) || resolveFromLabel(node, ROW_SEL);
        if (clickable) {
          clickable.click();
          return true;
        }
        // ラベルの隣にある行そのものをクリックする(div行のレイアウト)
        const scope = node.parentElement;
        const row = scope && [...scope.children].find((c) => c !== node && isVisible(c));
        if (row) {
          row.click();
          return true;
        }
      }
    }
    return false;
  }

  async function pickOnPage(wanted) {
    const cands = await waitFor(() => {
      const c = clickableCandidates();
      return c.length ? c : null;
    }, 5000);
    if (!cands) return { ok: false, reason: '選択肢が表示されませんでした' };
    const best = pickBest(cands.map((c) => c.textContent), wanted);
    if (!best) {
      const sample = cands.slice(0, 6).map((c) => c.textContent.trim().slice(0, 16)).join(' / ');
      return { ok: false, reason: `該当なし(候補: ${sample})` };
    }
    cands[best.index].click();
    return { ok: true, chosen: best.text };
  }

  async function fillViaPage(spec, value, isFormReady) {
    const parts = spec.cascade
      ? String(value).split(/\s*[>›»]\s*/).filter(Boolean)
      : [String(value)];
    if (!(await openSelectionPage(spec))) {
      return [{ part: parts[0], ok: false, reason: '選択ページを開けませんでした' }];
    }
    if (spec.path) await waitFor(() => location.pathname.startsWith(spec.path), 4000);
    else await sleep(500);

    const out = [];
    for (const part of parts) {
      const r = await pickOnPage(part);
      out.push({ part, ...r });
      if (!r.ok) break;
      await sleep(450);
    }
    // フォームに戻る(自動で戻らない実装のときは履歴を戻す)
    if (isFormReady) {
      const back = await waitFor(isFormReady, 2500);
      if (!back) {
        history.back();
        await waitFor(isFormReady, 3000);
      }
    }
    return out;
  }

  // ---------- 写真の投入 ----------
  function firstMatch(selectors, root, allowHidden = false) {
    for (const s of selectors || []) {
      const els = [...root.querySelectorAll(s)];
      const el = allowHidden ? els[0] : els.find(isVisible);
      if (el) return el;
    }
    return null;
  }

  // 投入できたかの汎用判定。プレビューはほぼ必ず blob:/data: のimgになるため、
  // サイト固有のクラス名に依存せず数えられる。
  function defaultCountPhotos() {
    return document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
  }

  async function injectPhotos(files, spec = {}, root = document) {
    if (!files.length) return { ok: false, reason: '写真がありません' };
    // file inputは display:none のことが多いので可視判定しない
    const input = firstMatch(spec.inputSelectors || ['input[type="file"]'], root, true);
    const zone = firstMatch(spec.dropzoneSelectors || [], root) || (input && input.closest('label, div'));
    const count = typeof spec.countPhotos === 'function' ? spec.countPhotos : defaultCountPhotos;
    const before = count();
    let accepted = false;

    // 1) file input へ直接セット(多くのフォームはこれで通る)
    if (input) {
      try {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        input.files = dt.files;
        accepted = input.files.length === files.length;
        fire(input, 'input');
        fire(input, 'change');
      } catch {
        /* 次の手段へ */
      }
      await sleep(700);
      const after = count();
      if (after > before) return { ok: true, method: `file-input(${after - before}枚を確認)` };
    }

    // 2) ドロップゾーンへ drop を合成(react-dropzone系はこちらが確実)
    if (zone) {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      await sleep(900);
      const after = count();
      if (after > before) return { ok: true, method: `drop(${after - before}枚を確認)` };
    }

    // ファイルは渡せたが画面への反映を確認できないケース。
    // 失敗と断定せず「要確認」として返す(サイト側が即アップロードする実装だと数えられない)
    if (accepted) {
      return { ok: true, method: `${files.length}枚を投入(画面で反映を確認してください)`, unverified: true };
    }
    return { ok: false, reason: '写真の投入に失敗しました(手動でドラッグしてください)' };
  }

  // ---------- タグ欄(Yahoo!フリマ: 1個ずつEnterで確定) ----------
  async function fillTags(spec, tags, root = document) {
    if (!tags?.length) return { ok: true, skipped: true };
    const el = findField(spec, root);
    if (!el) return { ok: false, reason: 'タグ欄が見つかりません' };
    let done = 0;
    for (const tag of tags) {
      el.focus();
      setNativeValue(el, tag);
      fire(el, 'input');
      await sleep(80);
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(
          new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 })
        );
      }
      await sleep(180);
      done += 1;
    }
    return { ok: true, added: done };
  }

  // ---------- フォーム構造のダンプ(セレクタ調整用) ----------
  function inspect(root = document) {
    const lines = [`URL: ${location.href}`, `title: ${document.title}`, ''];
    const near = (el) => {
      let node = el;
      for (let d = 0; d < 4 && node; d += 1) {
        const label = node.parentElement
          ? [...node.parentElement.querySelectorAll('label, legend, span, div, dt, h3, h4, b')]
              .map(ownText)
              .find((t) => t && t.length <= 24)
          : null;
        if (label) return label;
        node = node.parentElement;
      }
      return '';
    };
    for (const el of root.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"]')) {
      const attrs = ['type', 'name', 'id', 'placeholder', 'aria-label', 'data-testid', 'readonly', 'maxlength']
        .map((a) => (el.getAttribute?.(a) ? `${a}="${el.getAttribute(a)}"` : ''))
        .filter(Boolean)
        .join(' ');
      let extra = '';
      if (el.tagName === 'SELECT') {
        extra = ` options=[${[...el.options].slice(0, 30).map((o) => o.textContent.trim()).join(' | ')}]`;
      }
      lines.push(
        `<${el.tagName.toLowerCase()}> ${attrs}${extra} visible=${isVisible(el)} nearLabel="${near(el)}"`
      );
    }
    lines.push('', '--- buttons / choice-like ---');
    for (const el of root.querySelectorAll('button, [role="button"], [aria-haspopup]')) {
      if (!isVisible(el)) continue;
      const t = el.textContent.trim().slice(0, 30);
      if (!t) continue;
      lines.push(`<${el.tagName.toLowerCase()}> text="${t}" nearLabel="${near(el)}"`);
    }
    return lines.join('\n');
  }

  // ---------- サイトアダプタ ----------
  function registerSite(site) {
    sites.push(site);
  }

  function currentSite() {
    return sites.find((s) => {
      try {
        return s.match();
      } catch {
        return false;
      }
    });
  }

  // ---------- 実行本体 ----------
  // listing: サーバの /api/products/:slug の listing[site]
  async function fillForm(site, listing, files, opts = {}) {
    const results = [];
    const push = (label, r) => results.push({ label, ...r });
    const F = site.fields || {};
    const isFormReady = () => (F.title ? !!findField(F.title) : true);

    const CHOICE_ORDER = [
      ['category', 'カテゴリ'],
      ['condition', '商品の状態'],
      ['shippingPayer', '送料の負担'],
      ['shipping', '配送の方法'],
      ['shipFrom', '発送元の地域'],
      ['shipDays', '発送までの日数'],
    ];

    // 別ページ遷移が絡む項目を先に済ませる
    // (万一クライアント遷移でなく再読み込みが起きても、入力済みテキストを失わないため)
    if (opts.choices !== false) {
      for (const [key, label] of CHOICE_ORDER) {
        const spec = F[key];
        const value = listing[key];
        if (!spec || spec.kind !== 'page' || !value) continue;
        const steps = await fillViaPage(spec, value, isFormReady);
        steps.forEach((r, i) =>
          push(steps.length > 1 ? `${label}(${i + 1}/${steps.length}) ${r.part}` : label, r)
        );
        await sleep(300);
      }
    }

    if (opts.text !== false) {
      for (const [key, label] of [['title', 'タイトル'], ['description', '説明文'], ['price', '価格']]) {
        const spec = F[key];
        const value = listing[key];
        if (!spec || value === undefined || value === null || value === '') continue;
        const el = findField(spec);
        push(label, el ? await fillText(el, value) : { ok: false, reason: '入力欄が見つかりません' });
        await sleep(120);
      }
      if (F.tags && listing.tags?.length) {
        push('タグ', await fillTags(F.tags, listing.tags));
      }
    }

    if (opts.photos !== false && files?.length) {
      push(`写真(${files.length}枚)`, await injectPhotos(files, site.photo || {}));
    }

    if (opts.choices !== false) {
      for (const [key, label] of CHOICE_ORDER) {
        const spec = F[key];
        const value = listing[key];
        if (!spec || spec.kind === 'page' || !value) continue;

        if (spec.cascade) {
          // 階層カテゴリ。上位から順に選び、次の階層が現れるのを待つ
          const parts = String(value).split(/\s*[>›»]\s*/).filter(Boolean);
          const steps = await chooseCascade(findChoiceBlock(spec), parts);
          if (!steps.length) push(label, { ok: false, reason: '項目が見つかりません' });
          steps.forEach((r, i) => push(`${label}(${i + 1}/${parts.length}) ${r.part}`, r));
        } else {
          push(label, await chooseInBlock(findChoiceBlock(spec), value));
        }
        await sleep(250);
      }
    }

    return results;
  }

  Object.assign(window.XW3, {
    norm,
    score,
    pickBest,
    isVisible,
    sleep,
    fillText,
    findField,
    findChoiceBlock,
    chooseInBlock,
    chooseInSelect,
    injectPhotos,
    fillTags,
    inspect,
    registerSite,
    currentSite,
    getSites: () => sites.slice(),
    chooseCascade,
    fillForm,
  });
})();
