'use strict';

// mock-*.html 用のテストハーネス。
// 拡張として読み込まずに fill.js のロジックだけを実ブラウザで検証する。

window.XW3TEST = {
  // ダミー画像(1x1 PNG)からFileを作る
  makeFiles(n = 3) {
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return Array.from({ length: n }, (_, i) => new File([bytes], `0${i + 1}.png`, { type: 'image/png' }));
  },

  async run(siteId, listing, { expect = {}, checkDom = () => ({}) } = {}) {
    const out = document.getElementById('report');
    const lines = [];
    const site = window.XW3.getSites().find((s) => s.id === siteId);
    if (!site) {
      out.textContent = `site adapter "${siteId}" が見つかりません`;
      return;
    }

    const results = await window.XW3.fillForm(site, listing, this.makeFiles(3), {});

    lines.push('--- fillForm の結果 ---');
    for (const r of results) {
      lines.push(`${r.ok ? '<span class="ok">OK </span>' : '<span class="ng">NG </span>'}${r.label} ${
        r.ok ? r.chosen || r.method || r.value || '' : r.reason || ''
      }`);
    }

    let pass = 0;
    let fail = 0;
    lines.push('', '--- 期待値の照合 ---');
    for (const [label, want] of Object.entries(expect)) {
      const r = results.find((x) => x.label === label);
      const got = r ? r.chosen ?? r.value ?? '' : '(項目なし)';
      const ok = r?.ok && String(got).replace(/[^\d\p{L}\p{N}~]/gu, '') === String(want).replace(/[^\d\p{L}\p{N}~]/gu, '');
      lines.push(`${ok ? '<span class="ok">PASS</span>' : '<span class="ng">FAIL</span>'} ${label}: ${got}`);
      ok ? (pass += 1) : (fail += 1);
    }

    lines.push('', '--- DOMの実地確認 ---');
    for (const [label, ok] of Object.entries(checkDom())) {
      lines.push(`${ok ? '<span class="ok">PASS</span>' : '<span class="ng">FAIL</span>'} ${label}`);
      ok ? (pass += 1) : (fail += 1);
    }

    lines.unshift(`<b>${fail === 0 ? '<span class="ok">ALL PASS</span>' : `<span class="ng">${fail} FAILED</span>`} (pass ${pass} / fail ${fail})</b>`, '');
    out.innerHTML = lines.join('<br>');
    window.XW3TEST.summary = { pass, fail };
    document.title = `${fail === 0 ? 'ALL PASS' : fail + ' FAILED'} — ${document.title}`;
  },
};
