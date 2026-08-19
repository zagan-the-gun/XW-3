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
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    status('URLの形式が正しくありません(例: http://192.168.1.10:8720)', false);
    return;
  }
  // 任意のLANアドレスを許可するため、保存時にそのオリジンだけ権限を要求する
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
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
