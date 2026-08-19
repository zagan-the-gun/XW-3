'use strict';

// メルカリ(PC Web版 jp.mercari.com/sell/create)の出品フォーム定義
//
// 重要: カテゴリー / 商品の状態 / 配送の方法 は**フォーム内のプルダウンではなく専用ページへの遷移**
// (/sell/categories, /sell/conditions, /sell/shipping_methods)。
// 一方 配送料の負担 / 発送元の地域 / 発送までの日数 はネイティブ<select>。
// (2026-08 時点の本番JSバンドルの構造をもとにした定義)
//
// 実DOMとズレた場合はパネルの「フォーム構造をコピー」でダンプを取り、
// labels / openTexts / selectors を追記して調整する。

window.XW3.registerSite({
  id: 'mercari',
  name: 'メルカリ',
  match: () => /(^|\.)mercari\.com$/.test(location.hostname),
  isForm: () => /\/sell/.test(location.pathname),
  sellUrl: 'https://jp.mercari.com/sell/create',

  fields: {
    title: {
      labels: ['商品名'],
      placeholders: ['商品名'],
      names: ['name', 'title'],
    },
    description: {
      labels: ['商品の説明', '商品説明'],
      selectors: ['textarea'],
      placeholders: ['商品の説明'],
    },
    price: {
      labels: ['販売価格', '価格'],
      placeholders: ['価格'],
      names: ['price'],
    },

    // --- 別ページで選ぶ項目 ---
    category: {
      kind: 'page',
      cascade: true, // 「ハンドメイド・手芸 > 雑貨・ステーショナリー > ...」の3〜4階層
      labels: ['カテゴリー'],
      openTexts: ['カテゴリーを選択する', 'カテゴリーを選択'],
      path: '/sell/categories',
    },
    // ブランドは任意項目。検索欄に入力して候補から選ぶページ。
    // 行のテキストが「選択してください」で他項目と紛れるため openTexts は使わず
    // ラベル「ブランド」から後ろの行を辿る
    brand: {
      kind: 'page',
      search: true,
      labels: ['ブランド'],
      openTexts: ['選択してください'], // path指定のリンク検出が主。これは保険
      path: '/sell/brands',
    },
    condition: {
      kind: 'page',
      labels: ['商品の状態'],
      openTexts: ['商品の状態を選択する', '商品の状態を選択'],
      path: '/sell/conditions',
    },
    shipping: {
      kind: 'page',
      labels: ['配送の方法'],
      openTexts: ['配送の方法を選択する', '配送の方法を選択'],
      path: '/sell/shipping_methods',
    },

    // --- フォーム内のネイティブ<select> ---
    shippingPayer: {
      kind: 'choice',
      labels: ['配送料の負担'],
    },
    shipFrom: {
      kind: 'choice',
      labels: ['発送元の地域'],
    },
    shipDays: {
      kind: 'choice',
      labels: ['発送までの日数'],
    },
  },

  photo: {
    inputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    dropzoneSelectors: [
      '[data-testid*="image"]',
      '[class*="dropzone"]',
      'label[for*="image"]',
      'label:has(input[type="file"])',
    ],
  },
});
