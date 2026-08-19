'use strict';

// XW-3 出品テンプレ管理ツール — 依存ゼロの小型ローカルWebサービス
// データは DATA_DIR/products/<商品フォルダ>/{product.json, photos/NN.ext} のプレーン構造。
// フォルダ名は人間可読(Finder/SMBマウントから直接ドラッグする運用のため)。

const http = require('node:http');
const fs = require('node:fs/promises');
const fsc = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8720', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
// MacでSMBマウントした際のproductsのパス(例: /Volumes/xw3-data/products)。
// 「写真フォルダのパスをコピー」がこのプレフィックスで返す。
const PHOTO_PATH_PREFIX = process.env.PHOTO_PATH_PREFIX || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.avif']);
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PRODUCT_FIELDS = [
  'name', 'price', 'title', 'description', 'tags', 'brand', 'notes', 'sites',
  // 旧形式。読み出し時に sites 配下へ移行するため受け入れる
  'condition', 'categoryMemo', 'shippingMemo',
];
const SITE_KEYS = ['mercari', 'yahoo'];
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

// 各サイトの選択肢(2026-08時点の実表記)。UIのプルダウンに出し、
// 拡張はこの文字列でそのまま選択する。
// 出品ページ側はいずれも選択式で自由入力はできないため、UIも閉じたリストにする。
// 選択肢が増減したときはここだけ直せばよい。
const CHOICES = {
  mercari: {
    condition: [
      '新品、未使用', '未使用に近い', '目立った傷や汚れなし',
      'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い',
    ],
    shippingPayer: ['送料込み(出品者負担)', '着払い(購入者負担)'],
    // 3つのメルカリ便 + 「その他」配下
    shipping: [
      'らくらくメルカリ便', 'ゆうゆうメルカリ便', '梱包・発送たのメル便',
      'ゆうメール', 'レターパック', '郵便(定形、定形外、書留など)', 'クロネコヤマト',
      'ゆうパック', 'クリックポスト', 'ゆうパケット', '未定',
    ],
    shipDays: ['1~2日で発送', '2~3日で発送', '4~7日で発送'],
    shipFrom: PREFECTURES,
  },
  yahoo: {
    // Yahoo!フリマは5段階で「新品、」が付かない。配送料の負担は項目自体がない
    condition: ['未使用', '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり'],
    shipping: ['おてがる配送（ヤマト運輸）', 'おてがる配送（日本郵便）'],
    shipDays: ['1~2日', '2~3日', '3~7日'],
    shipFrom: PREFECTURES,
  },
};

// ---------- ユーティリティ ----------

function sanitizeFolderName(name) {
  let s = String(name || '')
    .replace(/[\/\\:*?"<>|\0]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
  return s || 'item';
}

// URLパスの1セグメントとして安全か(ディレクトリトラバーサル防止)
function isSafeSegment(seg) {
  return (
    typeof seg === 'string' &&
    seg.length > 0 &&
    seg.length <= 255 &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0') &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.startsWith('.')
  );
}

function productDir(slug) {
  return path.join(PRODUCTS_DIR, slug);
}

function photosDir(slug) {
  return path.join(productDir(slug), 'photos');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listPhotos(slug) {
  let entries;
  try {
    entries = await fs.readdir(photosDir(slug));
  } catch {
    return [];
  }
  return entries
    .filter((f) => !f.startsWith('.') && PHOTO_EXTS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function nextPhotoName(slug, ext) {
  const current = await listPhotos(slug);
  let max = 0;
  for (const f of current) {
    const m = f.match(/^(\d+)\./);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(2, '0') + ext;
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (await exists(productDir(slug))) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function normalizeProduct(input, prev) {
  const p = prev ? { ...prev } : {};
  for (const key of PRODUCT_FIELDS) {
    if (input[key] === undefined) continue;
    p[key] = input[key];
  }
  p.name = String(p.name || '').slice(0, 200) || '(名称未設定)';
  p.price = Number.isFinite(Number(p.price)) ? Math.max(0, Math.floor(Number(p.price))) : 0;
  p.title = String(p.title || '');
  p.description = String(p.description || '');
  p.tags = Array.isArray(p.tags)
    ? p.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 50)
    : [];
  p.notes = String(p.notes || '');
  // ブランドは両サイトで同じ表記のため共通で持つ(任意項目)
  p.brand = String(p.brand || '');

  // カテゴリ・状態・配送はサイトごとに選択肢の文言が違う(拡張がそのまま選択に使う値)。
  // 旧形式の共通フィールドは両サイトへ引き継いでから捨てる。
  const legacy = {
    category: String(p.categoryMemo || ''),
    condition: String(p.condition || ''),
    shipping: String(p.shippingMemo || ''),
  };
  const sites = typeof p.sites === 'object' && p.sites !== null ? p.sites : {};
  p.sites = {};
  for (const key of SITE_KEYS) {
    const s = typeof sites[key] === 'object' && sites[key] !== null ? sites[key] : {};
    p.sites[key] = {
      title: String(s.title || ''),
      category: String(s.category ?? s.categoryMemo ?? legacy.category ?? ''),
      condition: String(s.condition ?? legacy.condition ?? ''),
      shipping: String(s.shipping ?? s.shippingMemo ?? legacy.shipping ?? ''),
      // 以下は空なら共通設定(settings.json)の値を使う。受注製作と在庫品で
      // 発送までの日数が変わるなど、商品ごとに上書きしたい場合に指定する
      shipDays: String(s.shipDays || ''),
      shippingPayer: String(s.shippingPayer || ''),
      shipFrom: String(s.shipFrom || ''),
    };
  }
  delete p.categoryMemo;
  delete p.condition;
  delete p.shippingMemo;
  return p;
}

// かつて共通設定(settings.json)に置いていた送料負担・発送日数・発送元を商品側へ移す。
// 「どこで設定するのか分かりにくい」ため共通設定は廃止し、全て商品の編集画面に集約した。
// 既存の値を失わないよう、一度だけ各商品の空欄へ写してからファイルを畳む。
async function migrateLegacySettings() {
  let legacy;
  try {
    legacy = await readJson(SETTINGS_FILE);
  } catch {
    return; // 既に移行済み、または元から存在しない
  }
  const fields = ['shippingPayer', 'shipDays', 'shipFrom'];
  let slugs;
  try {
    slugs = (await fs.readdir(PRODUCTS_DIR)).filter((e) => !e.startsWith('.'));
  } catch {
    return;
  }
  for (const slug of slugs) {
    const file = path.join(productDir(slug), 'product.json');
    let raw;
    try {
      raw = await readJson(file);
    } catch {
      continue;
    }
    const p = normalizeProduct(raw, null);
    let changed = false;
    for (const key of SITE_KEYS) {
      for (const field of fields) {
        if (!p.sites[key][field] && legacy[key]?.[field]) {
          p.sites[key][field] = String(legacy[key][field]);
          changed = true;
        }
      }
    }
    if (changed) {
      p.createdAt = raw.createdAt || null;
      p.updatedAt = raw.updatedAt || null;
      await writeJson(file, p);
      console.log(`migrated legacy settings into: ${slug}`);
    }
  }
  await fs.rename(SETTINGS_FILE, `${SETTINGS_FILE}.migrated`).catch(() => {});
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // destroy()するとレスポンスより先にソケットが落ちて413が届かないため、
        // 残りのボディは読み捨てて接続を生かしたままrejectする
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  // text/plainフォーム偽装によるクロスサイトからの書き込み(CSRF)を遮断する
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  const body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw Object.assign(new Error('body must be a JSON object'), { status: 400 });
  }
  return body;
}

// キー単位でミューテーション(アップロード/並べ替え/削除)を直列化し、
// 複数クライアント同時操作でのファイル上書き・喪失レースを排除する
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// ---------- サンプル用PNG生成(単色) ----------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function seedSampleIfEmpty() {
  const entries = (await fs.readdir(PRODUCTS_DIR)).filter((e) => !e.startsWith('.'));
  if (entries.length > 0) return;
  const slug = 'サンプル商品(削除OK)';
  await fs.mkdir(photosDir(slug), { recursive: true });
  await writeJson(path.join(productDir(slug), 'product.json'), {
    name: 'サンプル商品(削除OK)',
    price: 1200,
    title: 'ハンドメイド 花モチーフ ピアス ブルー',
    description:
      'ハンドメイドの花モチーフピアスです。\n\n' +
      '・サイズ: 約2cm\n・素材: レジン、樹脂フック\n\n' +
      '一つひとつ手作業で制作しているため、色味や形に個体差があります。\n' +
      'ご理解いただける方のご購入をお願いいたします。',
    tags: ['ハンドメイド', 'ピアス', '花', 'アクセサリー'],
    notes: 'これはサンプルです。画像を出品フォームへドラッグする動作確認に使えます。',
    // 選択肢の文言は各サイトの実表記(2026-08時点)。状態は Yahoo!フリマだけ「新品、」が付かない
    sites: {
      mercari: {
        title: '',
        category: 'ハンドメイド・手芸 > アクセサリー・ジュエリー > ピアス',
        condition: '新品、未使用',
        shipping: 'ゆうゆうメルカリ便',
      },
      yahoo: {
        title: '',
        category: 'ハンドメイド、手作り > アクセサリー > ピアス',
        condition: '未使用',
        shipping: 'おてがる配送（日本郵便）',
      },
    },
  });
  const colors = [
    [90, 140, 220],
    [220, 140, 170],
    [120, 190, 140],
  ];
  for (let i = 0; i < colors.length; i++) {
    await fs.writeFile(
      path.join(photosDir(slug), `${String(i + 1).padStart(2, '0')}.png`),
      makePng(480, 360, colors[i])
    );
  }
}

// ---------- APIハンドラ ----------

async function listProducts() {
  const entries = (await fs.readdir(PRODUCTS_DIR)).filter((e) => !e.startsWith('.'));
  const items = [];
  for (const slug of entries) {
    const jsonPath = path.join(productDir(slug), 'product.json');
    if (!(await exists(jsonPath))) continue;
    try {
      const p = await readJson(jsonPath);
      const photos = await listPhotos(slug);
      items.push({
        slug,
        name: String(p.name ?? '(名称未設定)'),
        price: Number.isFinite(Number(p.price)) ? Number(p.price) : 0,
        updatedAt: p.updatedAt || null,
        photoCount: photos.length,
        photo: photos[0] ? `/photos/${encodeURIComponent(slug)}/${encodeURIComponent(photos[0])}` : null,
      });
    } catch {
      // 壊れたproduct.jsonはリストから除外(ファイルは残す)
    }
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items;
}

// 各サイトの出品フォームへそのまま入る形に整形する。
// UIのコピーボタンとChrome拡張の自動入力が同じ値を使うよう、ここが唯一の変換元。
function buildListing(p) {
  const out = {};
  const tags = p.tags || [];
  for (const key of SITE_KEYS) {
    const s = p.sites[key];
    out[key] = {
      title: s.title || p.title || '',
      // メルカリはタグ専用欄がないため説明文の末尾に#付きで結合する
      description:
        key === 'mercari' && tags.length
          ? `${p.description}\n\n${tags.map((t) => `#${t}`).join(' ')}`
          : p.description,
      tags: key === 'mercari' ? [] : tags, // Yahoo!フリマはタグ専用欄(#なし)
      price: p.price,
      brand: key === 'mercari' ? p.brand : '', // Yahoo!フリマにブランド項目はない
      category: s.category,
      condition: s.condition,
      shipping: s.shipping,
      shippingPayer: s.shippingPayer,
      shipDays: s.shipDays,
      shipFrom: s.shipFrom,
    };
  }
  return out;
}

async function getProduct(slug) {
  // product.jsonはSMB/gitでの手編集を想定しているため、読み出し時にも正規化する
  const raw = await readJson(path.join(productDir(slug), 'product.json'));
  const p = normalizeProduct(raw, null);
  p.createdAt = raw.createdAt || null;
  p.updatedAt = raw.updatedAt || null;
  return { ...p, slug, photos: await listPhotos(slug), listing: buildListing(p) };
}

async function createProduct(input) {
  const normalized = normalizeProduct(input, null);
  const slug = await uniqueSlug(sanitizeFolderName(normalized.name));
  normalized.createdAt = new Date().toISOString();
  normalized.updatedAt = normalized.createdAt;
  await fs.mkdir(photosDir(slug), { recursive: true });
  await writeJson(path.join(productDir(slug), 'product.json'), normalized);
  return getProduct(slug);
}

async function updateProduct(slug, input) {
  const jsonPath = path.join(productDir(slug), 'product.json');
  const prev = await readJson(jsonPath);
  const next = normalizeProduct(input, prev);
  next.createdAt = prev.createdAt || new Date().toISOString();
  next.updatedAt = new Date().toISOString();
  await writeJson(jsonPath, next);
  return getProduct(slug);
}

async function duplicateProduct(slug, name) {
  const src = await getProduct(slug);
  const newName = String(name || `${src.name} (コピー)`);
  const newSlug = await uniqueSlug(sanitizeFolderName(newName));
  await fs.mkdir(photosDir(newSlug), { recursive: true });
  const copy = normalizeProduct({ ...src, name: newName }, null);
  copy.createdAt = new Date().toISOString();
  copy.updatedAt = copy.createdAt;
  await writeJson(path.join(productDir(newSlug), 'product.json'), copy);
  for (const photo of src.photos) {
    await fs.copyFile(path.join(photosDir(slug), photo), path.join(photosDir(newSlug), photo));
  }
  return getProduct(newSlug);
}

async function deleteProduct(slug) {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.rename(productDir(slug), path.join(TRASH_DIR, `${slug}-${stamp}`));
}

async function uploadPhoto(slug, originalName, body) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!PHOTO_EXTS.has(ext)) {
    throw Object.assign(
      new Error(`unsupported extension: ${ext || '(none)'} — supported: ${[...PHOTO_EXTS].join(' ')}`),
      { status: 400 }
    );
  }
  let filename = await nextPhotoName(slug, ext);
  // flag:'wx'で既存ファイルの黙った上書きを防ぎ、衝突時は次の番号でリトライ
  for (;;) {
    try {
      await fs.writeFile(path.join(photosDir(slug), filename), body, { flag: 'wx' });
      return filename;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const n = parseInt(filename.match(/^(\d+)/)[1], 10) + 1;
      filename = String(n).padStart(2, '0') + ext;
    }
  }
}

async function reorderPhotos(slug, order) {
  const dir = photosDir(slug);
  const current = await listPhotos(slug);
  if (
    !Array.isArray(order) ||
    order.length !== current.length ||
    new Set(order).size !== order.length ||
    !order.every((f) => current.includes(f))
  ) {
    throw Object.assign(new Error('order must be a permutation of current photos'), { status: 400 });
  }
  // 一時名はリクエスト毎に一意にする(固定名だと並行・再実行で相互上書き=写真喪失になる)
  const token = crypto.randomUUID();
  const renamed = []; // [tmpName, originalName]
  try {
    for (let i = 0; i < order.length; i++) {
      const tmp = `.tmp-${token}-${i}${path.extname(order[i]).toLowerCase()}`;
      await fs.rename(path.join(dir, order[i]), path.join(dir, tmp));
      renamed.push([tmp, order[i]]);
    }
    const result = [];
    for (let i = 0; i < renamed.length; i++) {
      const name = String(i + 1).padStart(2, '0') + path.extname(renamed[i][0]);
      await fs.rename(path.join(dir, renamed[i][0]), path.join(dir, name));
      renamed[i] = null;
      result.push(name);
    }
    return result;
  } catch (err) {
    // 途中失敗時、tmpのままだと listPhotos から見えなくなるため必ず可視名へ戻す。
    // 元の名前が既に別ファイルに使われていたら空き番号へ退避する。
    for (const entry of renamed) {
      if (!entry) continue;
      const [tmp, original] = entry;
      const target = (await exists(path.join(dir, original)))
        ? await nextPhotoName(slug, path.extname(tmp))
        : original;
      await fs.rename(path.join(dir, tmp), path.join(dir, target)).catch(() => {});
    }
    throw err;
  }
}

// クラッシュ等で残った不可視の一時ファイル(.tmp-*)を起動時に空き番号へ回収する
async function recoverTmpPhotos() {
  let slugs;
  try {
    slugs = (await fs.readdir(PRODUCTS_DIR)).filter((e) => !e.startsWith('.'));
  } catch {
    return;
  }
  for (const slug of slugs) {
    let entries;
    try {
      entries = await fs.readdir(photosDir(slug));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.startsWith('.tmp-')) continue;
      const ext = path.extname(f).toLowerCase();
      if (!PHOTO_EXTS.has(ext)) continue;
      const name = await nextPhotoName(slug, ext);
      await fs.rename(path.join(photosDir(slug), f), path.join(photosDir(slug), name)).catch(() => {});
      console.log(`recovered orphan tmp photo: ${slug}/${f} -> ${name}`);
    }
  }
}

// ---------- HTTPサーバ ----------

async function handleApi(req, res, segments, url) {
  // /api/config
  if (segments[1] === 'config' && req.method === 'GET') {
    return sendJson(res, 200, { photoPathPrefix: PHOTO_PATH_PREFIX, productsDir: PRODUCTS_DIR });
  }

  // /api/choices — 選択項目の候補(UIのプルダウン用)
  if (segments[1] === 'choices' && req.method === 'GET') {
    return sendJson(res, 200, CHOICES);
  }

  if (segments[1] !== 'products') {
    return sendJson(res, 404, { error: 'not found' });
  }

  // /api/products
  if (segments.length === 2) {
    if (req.method === 'GET') return sendJson(res, 200, await listProducts());
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 201, await withLock('__create__', () => createProduct(body)));
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const slug = segments[2];
  if (!isSafeSegment(slug)) return sendJson(res, 400, { error: 'invalid product id' });
  if (!(await exists(path.join(productDir(slug), 'product.json')))) {
    return sendJson(res, 404, { error: 'product not found' });
  }

  // /api/products/:slug
  if (segments.length === 3) {
    if (req.method === 'GET') return sendJson(res, 200, await getProduct(slug));
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await withLock(slug, () => updateProduct(slug, body)));
    }
    if (req.method === 'DELETE') {
      await withLock(slug, () => deleteProduct(slug));
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // /api/products/:slug/duplicate
  if (segments.length === 4 && segments[3] === 'duplicate' && req.method === 'POST') {
    const body = await readJsonBody(req);
    return sendJson(res, 201, await withLock('__create__', () => duplicateProduct(slug, body.name)));
  }

  // /api/products/:slug/photo-urls — iOSショートカット用(絶対URLの配列を返す)
  if (segments.length === 4 && segments[3] === 'photo-urls' && req.method === 'GET') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const photos = await listPhotos(slug);
    return sendJson(res, 200, {
      urls: photos.map(
        (f) => `${proto}://${host}/photos/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`
      ),
    });
  }

  // /api/products/:slug/photos ...
  if (segments[3] === 'photos') {
    if (segments.length === 4 && req.method === 'PUT') {
      const body = await readBody(req, MAX_PHOTO_BYTES);
      if (body.length === 0) return sendJson(res, 400, { error: 'empty body' });
      const filename = await withLock(slug, () =>
        uploadPhoto(slug, url.searchParams.get('name'), body)
      );
      return sendJson(res, 201, { filename });
    }
    if (segments.length === 5 && segments[4] === 'reorder' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const photos = await withLock(slug, () => reorderPhotos(slug, body.order));
      return sendJson(res, 200, { photos });
    }
    if (segments.length === 5 && req.method === 'DELETE') {
      const file = segments[4];
      if (!isSafeSegment(file) || !PHOTO_EXTS.has(path.extname(file).toLowerCase())) {
        return sendJson(res, 400, { error: 'invalid filename' });
      }
      await withLock(slug, () => fs.unlink(path.join(photosDir(slug), file)));
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

function servePhoto(req, res, segments) {
  const [, slug, file] = segments;
  if (!isSafeSegment(slug) || !isSafeSegment(file)) {
    return sendJson(res, 400, { error: 'bad path' });
  }
  const ext = path.extname(file).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) return sendJson(res, 404, { error: 'not found' });
  const filePath = path.join(photosDir(slug), file);
  const stream = fsc.createReadStream(filePath);
  stream.on('error', () => sendJson(res, 404, { error: 'not found' }));
  stream.on('open', () => {
    // 並べ替えでファイル名と中身の対応が変わるためキャッシュさせない
    // (古いキャッシュを掴むと、ドラッグで運ばれる画像バイトまで古くなる)
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel.includes('..') || rel.includes('\0')) return sendJson(res, 400, { error: 'bad path' });
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 400, { error: 'bad path' });
  }
  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) return sendJson(res, 404, { error: 'not found' });
  const stream = fsc.createReadStream(filePath);
  stream.on('error', () => sendJson(res, 404, { error: 'not found' }));
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': type });
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let segments;
    try {
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return sendJson(res, 400, { error: 'bad url encoding' });
    }

    if (segments[0] === 'api') return await handleApi(req, res, segments, url);
    if (segments[0] === 'photos' && segments.length === 3 && req.method === 'GET') {
      return servePhoto(req, res, segments);
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    return sendJson(res, status, { error: err.message || 'internal error' });
  }
});

async function main() {
  await fs.mkdir(PRODUCTS_DIR, { recursive: true });
  await seedSampleIfEmpty();
  await recoverTmpPhotos();
  await migrateLegacySettings();
  server.listen(PORT, () => {
    console.log(`XW-3 listening on http://0.0.0.0:${PORT}  (data: ${DATA_DIR})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
