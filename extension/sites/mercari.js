'use strict';

// メルカリ(PC Web版)の出品フォーム定義
// labels は画面に出るラベル文字列。DOM変更に強くするため候補を複数持たせる。
// 実際のDOMを見て詰めたい場合はパネルの「フォーム構造をコピー」を使う。

window.XW3.registerSite({
  id: 'mercari',
  name: 'メルカリ',
  match: () => /(^|\.)mercari\.com$/.test(location.hostname),
  isForm: () => /\/sell/.test(location.pathname),
  sellUrl: 'https://jp.mercari.com/sell/create',

  fields: {
    title: {
      labels: ['商品名', '商品名と説明'],
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
      placeholders: ['価格', '300'],
      names: ['price'],
    },
    category: {
      kind: 'choice',
      labels: ['カテゴリー', 'カテゴリ'],
    },
    condition: {
      kind: 'choice',
      labels: ['商品の状態'],
    },
    shippingPayer: {
      kind: 'choice',
      labels: ['配送料の負担', '送料の負担'],
    },
    shipping: {
      kind: 'choice',
      labels: ['配送の方法', '配送方法'],
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
