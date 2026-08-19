'use strict';

// Yahoo!フリマ(Web版 paypayfleamarket.yahoo.co.jp/sell)の出品フォーム定義
//
// メルカリとの違い(2026-08時点の本番JSバンドル構造より):
// - 「配送料の負担」項目が存在しない(全商品が出品者負担・全国一律・匿名配送で固定)
// - ハッシュタグは専用欄
// - カテゴリ / 商品の状態 はボトムシート(フォーム内のカスタムUI。ページ遷移はしない)
// - 配送方法はアコーディオン+ラジオ(業者2択)
// - 発送までの日数 / 発送元の地域 はネイティブ<select> (name="timeToShip" / "prefectures")
// - フォーム内の項目名は「配送方法」(商品ページ側は「配送の方法」と揺れる)

window.XW3.registerSite({
  id: 'yahoo',
  name: 'Yahoo!フリマ',
  // 出品フォームは別ドメイン(paypayfleamarket-sec.yahoo.co.jp/item/add)にある。
  // /sell は出品トップ(下書き一覧など)で、そこから「出品する」で遷移する
  match: () => /paypayfleamarket(-sec)?\.yahoo\.co\.jp$/.test(location.hostname),
  isForm: () => /\/item\/add/.test(location.pathname),
  sellUrl: 'https://paypayfleamarket-sec.yahoo.co.jp/item/add?from=sellTop',

  fields: {
    title: {
      labels: ['商品名', 'タイトル'],
      placeholders: ['商品名'],
      names: ['title', 'name'],
    },
    description: {
      labels: ['商品説明', '商品の説明', '説明'],
      selectors: ['textarea'],
      placeholders: ['商品の説明', '商品説明'],
    },
    price: {
      labels: ['販売価格', '価格'],
      placeholders: ['価格'],
      names: ['price'],
    },
    tags: {
      labels: ['ハッシュタグ', 'タグ'],
      placeholders: ['ハッシュタグ', 'タグ'],
    },

    category: {
      kind: 'choice',
      cascade: true, // 「アウトドア、釣り、旅行用品 > 釣り > ...」の3〜5階層(ボトムシートでドリルダウン)
      labels: ['カテゴリ'],
      // 商品名から推測した候補(「カテゴリはこちらですか」)が先に出るため、
      // 一覧の先頭に戻してから階層を辿る
      resetTexts: ['他のカテゴリから選ぶ'],
    },
    // 任意項目。入力欄に打ち込むと候補が出るので、そこから選ぶ
    // (メルカリは専用ページでの検索なのでUIが違う)
    brand: {
      kind: 'autocomplete',
      labels: ['ブランド'],
      placeholders: ['ブランドを入力'],
    },
    condition: {
      kind: 'choice',
      labels: ['商品の状態', '商品状態'],
    },
    // shippingPayer は項目が存在しないため定義しない(全品出品者負担)
    shipping: {
      kind: 'choice',
      labels: ['配送方法', '配送の方法'],
    },
    shipFrom: {
      kind: 'choice',
      labels: ['発送元の地域', '発送元'],
      names: ['prefectures'],
    },
    shipDays: {
      kind: 'choice',
      labels: ['発送までの日数', '発送日数'],
      names: ['timeToShip'],
    },
  },

  photo: {
    inputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    dropzoneSelectors: ['[class*="dropzone"]', '[class*="ImageUpload"]', 'label:has(input[type="file"])'],
    // クラス名が当たらない場合は画面の案内文からドロップ先を探す
    dropzoneTexts: ['ドラッグ＆ドロップして追加', 'ドラッグ＆ドロップ', '画像を追加する'],
  },
});
