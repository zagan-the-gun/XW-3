'use strict';

const input = document.getElementById('base');
const statusEl = document.getElementById('status');

function status(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'ng';
}

chrome.storage.local.get('baseUrl').then(({ baseUrl }) => {
  input.value = baseUrl || 'http://localhost:8720';
});

document.getElementById('save').addEventListener('click', async () => {
  const raw = input.value.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    status('URLの形式が正しくありません(例: http://192.168.11.15:8720)', false);
    return;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    status('http:// または https:// で始まるURLを入力してください', false);
    return;
  }
  // 任意のLANアドレスを許可するため、保存時にそのホストの権限だけを要求する。
  // Chromeの権限パターンはポート番号を含められない(含めると無効な指定になる)ため、
  // ホスト名までで指定する(そのホストの全ポートが対象になる)
  const pattern = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    status('アクセス許可が得られませんでした', false);
    return;
  }
  await chrome.storage.local.set({ baseUrl: raw });
  status('保存しました');
});

document.getElementById('test').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'products' }, (res) => {
    if (chrome.runtime.lastError) {
      status(`接続失敗: ${chrome.runtime.lastError.message}`, false);
    } else if (!res?.ok) {
      status(`接続失敗: ${res?.error}`, false);
    } else {
      status(`接続OK — 商品${res.data.length}件を取得しました`);
    }
  });
});
