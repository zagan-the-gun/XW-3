'use strict';

// Yahoo!フリマ(Web版)の出品フォーム定義
// メルカリと違いハッシュタグは専用欄。カテゴリ階層も体系が別。

window.XW3.registerSite({
  id: 'yahoo',
  name: 'Yahoo!フリマ',
  match: () => /paypayfleamarket\.yahoo\.co\.jp$/.test(location.hostname),
  isForm: () => /\/sell/.test(location.pathname),
  sellUrl: 'https://paypayfleamarket.yahoo.co.jp/sell',

  fields: {
    title: {
      labels: ['商品名', 'タイトル'],
      placeholders: ['商品名'],
      names: ['title', 'name'],
    },
    description: {
      labels: ['商品の説明', '商品説明', '説明'],
      selectors: ['textarea'],
      placeholders: ['商品の説明'],
    },
    price: {
      labels: ['価格', '販売価格'],
      placeholders: ['価格'],
      names: ['price'],
    },
    tags: {
      labels: ['ハッシュタグ', 'タグ'],
      placeholders: ['ハッシュタグ', 'タグ'],
    },
    category: {
      kind: 'choice',
      labels: ['カテゴリ', 'カテゴリー'],
    },
    condition: {
      kind: 'choice',
      labels: ['商品の状態', '商品状態'],
    },
    shippingPayer: {
      kind: 'choice',
      labels: ['送料負担', '配送料の負担', '送料'],
    },
    shipping: {
      kind: 'choice',
      labels: ['配送方法', '配送の方法'],
    },
    shipFrom: {
      kind: 'choice',
      labels: ['発送元の地域', '発送元'],
    },
    shipDays: {
      kind: 'choice',
      labels: ['発送までの日数', '発送日数'],
    },
  },

  photo: {
    inputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    dropzoneSelectors: ['[class*="dropzone"]', '[class*="ImageUpload"]', 'label:has(input[type="file"])'],
  },
});
