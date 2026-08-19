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
    // 部分一致は長さ比で減点する。これがないと「メルカリ」(ロゴ等)が
    // 「ゆうゆうメルカリ便」に一致してしまい、誤った選択を成功扱いしてしまう
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (a.startsWith(b) || b.startsWith(a)) return Math.round(60 + 30 * ratio);
    if (a.includes(b) || b.includes(a)) return Math.round(45 + 30 * ratio);
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

  // 画面に出ている選択肢から wanted に一致するものを探す。
  // role や class に依存せず「その文字列を持つ要素」で探すため、
  // プレーンなdivで組まれたボトムシート(Yahoo!フリマ)でも拾える。
  function findVisibleOption(wanted, excludeIn) {
    const inSheet = (n) => isVisible(n) && inMainContent(n) && !(excludeIn && excludeIn.contains(n));
    const byText = labelNodes(wanted).filter(inSheet);
    if (byText.length) {
      const best = pickBest(byText.map((n) => ownText(n) || n.textContent), wanted);
      if (best) return byText[best.index];
    }
    const nodes = collectOptionNodes().filter(inSheet);
    if (nodes.length) {
      const best = pickBest(nodes.map((n) => n.textContent), wanted);
      if (best) return nodes[best.index];
    }
    return null;
  }

  // 開いたシート/モーダルを閉じる。失敗した項目のUIが残ると後続の操作を邪魔する
  async function closeOverlay() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27 })
    );
    await sleep(250);
    for (const t of ['閉じる', 'キャンセル']) {
      for (const node of labelNodes(t)) {
        if (!isVisible(node)) continue;
        const el = node.closest(ROW_SEL) || node;
        if (NEVER_CLICK.test(el.textContent || '')) continue;
        el.click();
        await sleep(250);
        return;
      }
    }
  }

  async function chooseInCustom(trigger, wanted, block) {
    trigger.click();
    const node = await waitFor(() => findVisibleOption(wanted, block), 2500);
    if (!node) {
      const sample = collectOptionNodes()
        .slice(0, 6)
        .map((n) => n.textContent.trim().slice(0, 16))
        .join(' / ');
      await closeOverlay();
      return {
        ok: false,
        reason: `選択肢に「${wanted}」が見つかりません${sample ? `(候補: ${sample})` : ''}`,
      };
    }
    (node.closest(ROW_SEL) || node).click();
    await sleep(250);
    return { ok: true, chosen: (ownText(node) || wanted).slice(0, 40) };
  }

  const TRIGGER_SEL = '[role="combobox"], [aria-haspopup], button, [role="button"], input[readonly]';

  function triggerIn(block) {
    if (!block) return null;
    if (block.matches?.(TRIGGER_SEL)) return block;
    const direct = [...block.querySelectorAll(TRIGGER_SEL)].find(isVisible);
    if (direct) return direct;
    // Yahoo!フリマのように、値を表示するプレーンなdivがそのままボタンの役割を持つ場合
    if (isVisible(block) && ownText(block)) return block;
    return null;
  }

  // 既に選択肢が開いていればそこから選び、開いていなければトリガーを押してから選ぶ
  // (階層カテゴリは1段目を選ぶと同じモーダル内に2段目が出る作りが多い)
  async function chooseCustomStep(block, wanted) {
    // すでにシートが開いていればその中から選ぶ(階層カテゴリの2段目以降)
    const open = findVisibleOption(wanted, block);
    if (open) {
      (open.closest(ROW_SEL) || open).click();
      await sleep(250);
      return { ok: true, chosen: (ownText(open) || wanted).slice(0, 40) };
    }
    const trigger = triggerIn(block);
    if (!trigger) return { ok: false, reason: '選択UIを特定できません' };
    return chooseInCustom(trigger, wanted, block);
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
    if (trigger) return chooseInCustom(trigger, wanted, block);
    return { ok: false, reason: '選択UIを特定できません' };
  }

  // ---------- 隣の項目の誤取得を防ぐ ----------
  // 1枚のカードに「配送方法/発送までの日数/発送元の地域」がまとめて入っている等、
  // ラベルの祖先を広げると隣の項目のプルダウンを掴んでしまう。
  // 対象ラベルと候補コントロールの間に「別の項目のラベル」が挟まる候補を落とす。

  let knownLabels = []; // [{el, key}]

  function indexKnownLabels(site) {
    const keys = new Set();
    for (const spec of Object.values(site?.fields || {})) {
      for (const l of spec.labels || []) keys.add(norm(l));
    }
    knownLabels = [];
    if (!keys.size) return;
    for (const el of document.querySelectorAll(
      'label, legend, h1, h2, h3, h4, h5, dt, th, b, strong, span, div, p'
    )) {
      const t = ownText(el);
      if (!t || t.length > 24) continue;
      const key = norm(t);
      if (keys.has(key)) knownLabels.push({ el, key });
    }
  }

  function isBlockedByOtherLabel(labelEl, control, ownKeys) {
    for (const { el, key } of knownLabels) {
      if (el === labelEl || ownKeys.has(key)) continue;
      if (el.contains(control) || control.contains(el) || el.contains(labelEl)) continue;
      const afterLabel = labelEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
      const beforeControl = el.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (afterLabel && beforeControl) return true;
    }
    return false;
  }

  // 候補のうち「別ラベルに遮られていないもの」を優先する。
  // 全部遮られている場合は従来どおり先頭を返す(改善であって後退させない)
  function preferUnblocked(candidates, labelEl, spec) {
    if (!knownLabels.length || candidates.length === 0) return candidates;
    const ownKeys = new Set((spec?.labels || []).map(norm));
    const ok = candidates.filter((c) => !isBlockedByOtherLabel(labelEl, c, ownKeys));
    return ok.length ? ok : candidates;
  }

  // ---------- ラベルから入力欄を探す ----------
  function labelNodes(text, root = document) {
    const t = norm(text);
    if (!t) return [];
    const out = [];
    // a / button も対象にする。メルカリの「カテゴリーを選択する」のように
    // リンク自身が直接テキストを持つ行があり、これを外すと見つけられない。
    for (const el of root.querySelectorAll(
      'label, legend, h1, h2, h3, h4, h5, span, div, p, dt, th, b, strong, a, button, li'
    )) {
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
  function resolveFromLabel(labelEl, selector, spec) {
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
      const found = preferUnblocked(orderedControls(node, selector, labelEl), labelEl, spec);
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
        const el = resolveFromLabel(node, selector, spec);
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

          const radios = preferUnblocked(
            [...cur.querySelectorAll('input[type="radio"]')].filter(isVisible),
            node,
            spec
          );
          if (radios.length > 1) return cur;

          const selects = preferUnblocked(orderedControls(cur, 'select', node), node, spec);
          // 広すぎる祖先(ページ全体)を掴んだ場合は打ち切る
          if (selects.length > 6) break;
          // 複数あるのは階層カテゴリのとき。それ以外は隣の項目なので先頭だけを使う
          if (selects.length > 1) return spec.cascade ? cur : selects[0];
          if (selects.length === 1) return selects[0];

          const triggers = preferUnblocked(orderedControls(cur, TRIGGER_SEL, node), node, spec);
          if (triggers.length) return spec.cascade ? cur : triggers[0];

          // role属性もbuttonも持たない「値を表示する行」(Yahoo!フリマのピッカー)。
          // ラベル直後にある短いテキストの要素を選択UIとみなす(最後の手段)
          const rows = preferUnblocked(
            orderedControls(cur, 'div, span, a, p', node).filter((el) => {
              if (node.contains(el) || el.contains(node)) return false;
              const t = ownText(el);
              return t && t.length <= 30;
            }),
            node,
            spec
          );
          if (rows.length) return rows[0];

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

  // 行の実装はリンク・ボタン・div+onClickのいずれもあり得る。
  // クリック候補を集めて順に試し、「実際に開いたか」を確認できたものを採用する。
  function openTargets(spec) {
    const targets = [];

    // 遷移先のパスが分かっているなら、そのパスへのリンクを直接探すのが最も確実
    // (行の見た目や文言に依存しない)
    if (spec.path) {
      for (const a of document.querySelectorAll(`a[href*="${spec.path}"]`)) {
        if (isVisible(a)) targets.push(a);
      }
    }

    for (const t of spec.openTexts || []) {
      for (const node of labelNodes(t)) targets.push(node.closest(ROW_SEL) || node);
      for (const c of clickableCandidates()) {
        if (score(c.textContent, t) >= 80) targets.push(c);
      }
    }

    for (const label of spec.labels || []) {
      for (const node of labelNodes(label)) {
        // ラベルの後ろにあるリンク/ボタンを(1つではなく)全部候補にする。
        // 行がラッパーdivで包まれている場合、最初の1つだけではリンクに届かない
        let scope = node;
        for (let d = 0; d < 4 && scope && scope.tagName !== 'BODY'; d += 1) {
          const found = [
            ...orderedControls(scope, 'a, button, [role="button"]', node),
            ...orderedControls(scope, ROW_SEL, node),
          ];
          if (found.length) {
            targets.push(...found);
            break; // 隣の項目まで広げない
          }
          scope = scope.parentElement;
        }
        // ラベルの隣にある行そのもの(div行のレイアウト)
        const parent = node.parentElement;
        const row = parent && [...parent.children].find((c) => c !== node && isVisible(c));
        if (row) targets.push(row);
      }
    }
    return [...new Set(targets)].filter((el) => el && isVisible(el));
  }

  function clickWithMouseEvents(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    }
  }

  async function openSelectionPage(spec, isOpen) {
    const targets = openTargets(spec);
    if (!targets.length) {
      return { ok: false, reason: '選択ページを開く行が見つかりません' };
    }
    const startHref = location.href;
    // まず素直な click()、それで開かなければマウスイベント列を送る
    for (const send of [(el) => el.click(), clickWithMouseEvents]) {
      for (const el of targets) {
        if (!el.isConnected) continue; // 前のクリックでDOMが差し替わった要素は触らない
        send(el);
        if (await waitFor(isOpen, 1200)) return { ok: true };
        // 想定外のページへ移動したら、以降のクリックは誤操作になるので即中止する
        if (location.href !== startHref) {
          return { ok: false, reason: `別のページ(${location.pathname})へ移動しました` };
        }
      }
    }
    return { ok: false, reason: '行をクリックしても選択ページが開きませんでした' };
  }

  // 「更新する」等でページの選択を確定する必要がある画面向け。
  // 出品そのものを実行するボタンは絶対に押さない。
  const CONFIRM_TEXTS = ['更新する', '決定', '完了', '保存', '適用', 'この内容で登録'];
  const NEVER_CLICK = /出品|購入|支払|削除/;

  function confirmButton() {
    for (const t of CONFIRM_TEXTS) {
      for (const node of labelNodes(t)) {
        if (!inMainContent(node)) continue;
        const el = node.closest(ROW_SEL) || node;
        if (NEVER_CLICK.test(el.textContent || '')) continue;
        return el;
      }
    }
    return null;
  }

  // ヘッダー・ナビ・フッターの要素は選択肢ではないので候補から外す
  // (ロゴの「メルカリ」等が誤ってマッチするのを防ぐ)
  function inMainContent(el) {
    return !el.closest(
      'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]'
    );
  }

  async function pickOnPage(wanted) {
    await sleep(250); // DOM差し替え直後に古い内容を拾わないよう一呼吸置く

    // 1) 値そのものを持つ要素を探し、クリックできる祖先を押す
    //    (選択肢の行がプレーンなdivで実装されていても拾える)
    //    「DAIWA」を選びたいのに「DAIWA Industry」が先に並ぶことがあるため、
    //    見つかった順ではなくスコアが最良のものを選ぶ
    const direct = labelNodes(wanted).filter(inMainContent);
    if (direct.length) {
      const best = pickBest(direct.map((n) => ownText(n) || n.textContent), wanted);
      if (best) {
        const node = direct[best.index];
        (node.closest(ROW_SEL) || node).click();
        return { ok: true, chosen: (ownText(node) || wanted).slice(0, 40) };
      }
    }

    // 2) クリック可能な要素をスコアリングして選ぶ
    const cands =
      (await waitFor(() => {
        const c = clickableCandidates().filter(inMainContent);
        return c.length ? c : null;
      }, 4000)) || [];
    if (!cands.length) return { ok: false, reason: '選択肢が表示されませんでした' };
    const best = pickBest(cands.map((c) => c.textContent), wanted);
    if (!best) {
      const sample = cands.slice(0, 8).map((c) => c.textContent.trim().slice(0, 16)).join(' / ');
      return { ok: false, reason: `該当なし(候補: ${sample})` };
    }
    cands[best.index].click();
    return { ok: true, chosen: best.text };
  }

  async function fillViaPage(spec, value, isFormReady) {
    const parts = spec.cascade
      ? String(value).split(/\s*[>›»]\s*/).filter(Boolean)
      : [String(value)];
    // 「開いた」の判定。パス指定があれば遷移、なければ選択肢の出現で見る
    const isOpen = spec.path
      ? () => location.pathname.startsWith(spec.path)
      : () => collectOptionNodes().length > 0;

    const opened = await openSelectionPage(spec, isOpen);
    if (!opened.ok) {
      // 開けていない状態で選択肢を探すと無関係な候補を拾うため、ここで打ち切る
      return [{ part: parts[0], ok: false, reason: opened.reason }];
    }

    // ブランドのように「検索して候補から選ぶ」ページ
    if (spec.search) {
      const input = await waitFor(
        () =>
          [...document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')]
            .filter((el) => isVisible(el) && inMainContent(el))[0] || null,
        3000
      );
      if (!input) {
        return [{ part: parts[0], ok: false, reason: '検索欄が見つかりません' }];
      }
      await fillText(input, parts[0]);
      await sleep(900); // 候補の絞り込みを待つ
    }

    const out = [];
    for (const part of parts) {
      const r = await pickOnPage(part);
      out.push({ part, ...r });
      if (!r.ok) break;
      await sleep(450);
    }

    // フォームへ戻る。選択しただけでは確定しない画面(「更新する」ボタンがある)にも対応する
    if (isFormReady) {
      let back = await waitFor(isFormReady, 1500);
      if (!back) {
        const btn = confirmButton();
        if (btn) {
          btn.click();
          back = await waitFor(isFormReady, 2500);
          out.push({ part: btn.textContent.trim().slice(0, 12), ok: !!back, chosen: '確定' });
        }
      }
      if (!back) {
        history.back();
        await waitFor(isFormReady, 2500);
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

  // 「ここにドラッグ＆ドロップ」のような案内文からドロップ先を探す。
  // クラス名に依存しないため、サイトの実装が変わっても効きやすい
  function findByTextContains(phrase) {
    const p = norm(phrase);
    if (!p) return null;
    const hits = [...document.querySelectorAll('div, label, p, span, section, form')].filter(
      (el) => isVisible(el) && norm(el.textContent).includes(p)
    );
    // 最も内側の要素を返す(クリック/ドロップは親へ伝播する)
    return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o))).pop() || null;
  }

  async function injectPhotos(files, spec = {}, root = document) {
    if (!files.length) return { ok: false, reason: '写真がありません' };
    // file inputは display:none のことが多いので可視判定しない
    const input = firstMatch(spec.inputSelectors || ['input[type="file"]'], root, true);
    const zone =
      firstMatch(spec.dropzoneSelectors || [], root) ||
      (spec.dropzoneTexts || []).map(findByTextContains).find(Boolean) ||
      (input && input.closest('label, div'));
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
    lines.push('', '--- クリック可能な要素(行・リンク・ボタン) ---');
    for (const el of root.querySelectorAll(
      'a, button, [role="button"], [role="link"], [aria-haspopup], [tabindex], [class*="row"], [class*="Row"], li'
    )) {
      if (!isVisible(el)) continue;
      const t = el.textContent.trim().slice(0, 36);
      if (!t) continue;
      const attrs = ['href', 'class', 'data-testid', 'role', 'tabindex']
        .map((a) => (el.getAttribute?.(a) ? `${a}="${String(el.getAttribute(a)).slice(0, 60)}"` : ''))
        .filter(Boolean)
        .join(' ');
      // 直下テキストか子要素のテキストかで探索方法が変わるため両方出す
      lines.push(
        `<${el.tagName.toLowerCase()}> ${attrs} text="${t}" ownText="${ownText(el).slice(0, 36)}"`
      );
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

    // 画面に出てくる順(依存関係の順)に処理する
    const CHOICE_ORDER = [
      ['category', 'カテゴリ'],
      ['brand', 'ブランド'],
      ['condition', '商品の状態'],
      ['shippingPayer', '送料の負担'],
      ['shipping', '配送の方法'],
      ['shipFrom', '発送元の地域'],
      ['shipDays', '発送までの日数'],
    ];

    // 選択項目はCHOICE_ORDERの順に処理する。
    // 配送の方法は配送料の負担を選ぶまで行が出ないなど依存関係があるため、
    // ページ遷移型と画面内選択を混ぜて「表示される順」に埋めるのが要点。
    // テキストと写真は全ての遷移が終わったあとに入れる。
    if (opts.choices !== false) {
      for (const [key, label] of CHOICE_ORDER) {
        const spec = F[key];
        const value = listing[key];
        if (!spec || !value) continue;

        indexKnownLabels(site); // 遷移やシート開閉でDOMが変わるため項目ごとに取り直す

        if (spec.kind === 'page') {
          const steps = await fillViaPage(spec, value, isFormReady);
          steps.forEach((r, i) =>
            push(steps.length > 1 ? `${label}(${i + 1}/${steps.length}) ${r.part}` : label, r)
          );
        } else if (spec.cascade) {
          const parts = String(value).split(/\s*[>›»]\s*/).filter(Boolean);
          const steps = await chooseCascade(findChoiceBlock(spec), parts);
          if (!steps.length) push(label, { ok: false, reason: '項目が見つかりません' });
          steps.forEach((r, i) => push(`${label}(${i + 1}/${parts.length}) ${r.part}`, r));
        } else {
          push(label, await chooseInBlock(findChoiceBlock(spec), value));
        }
        await sleep(300);
      }
    }

    if (opts.text !== false) {
      for (const [key, label] of [['title', 'タイトル'], ['description', '説明文'], ['price', '価格']]) {
        const spec = F[key];
        const value = listing[key];
        if (!spec || value === undefined || value === null || value === '') continue;
        indexKnownLabels(site);
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
