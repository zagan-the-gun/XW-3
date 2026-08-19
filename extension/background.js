'use strict';

// XW-3 出品くん Filler — service worker
// content script からの fetch は出品サイトのオリジン扱いでCORSに阻まれるため、
// XW-3サーバへのアクセスは必ずここを経由する。

const DEFAULT_BASE = 'http://localhost:8720';

async function getBase() {
  const { baseUrl } = await chrome.storage.local.get('baseUrl');
  return String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

async function getJson(pathname) {
  const base = await getBase();
  const res = await fetch(base + pathname, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${base + pathname}`);
  return res.json();
}

// 写真は1枚ずつ base64 で content script へ渡す
// (20枚まとめると1メッセージが巨大になるため)
async function getPhoto(url) {
  const base = await getBase();
  const res = await fetch(base + url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return {
    base64: btoa(binary),
    type: res.headers.get('content-type') || 'application/octet-stream',
  };
}

const handlers = {
  // 接続先の設定画面はパネルから開けるようにする(詳細ページの奥にあって探しにくい)
  openOptions: async () => {
    chrome.runtime.openOptionsPage();
    return true;
  },
  base: () => getBase(),
  products: () => getJson('/api/products'),
  product: ({ slug }) => getJson(`/api/products/${encodeURIComponent(slug)}`),
  photo: ({ url }) => getPhoto(url),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    reply({ ok: false, error: `unknown message: ${msg?.type}` });
    return false;
  }
  handler(msg)
    .then((data) => reply({ ok: true, data }))
    .catch((err) => reply({ ok: false, error: err.message }));
  return true; // 非同期応答
});
