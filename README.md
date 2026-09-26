# three-js-sandbox

Three.js + Rapier による船の浸水・沈没シミュレーション。魚雷で破口を開け、区画ごとの浸水と沈み方を 3D で観察できる。

## 動かし方

Node.js 20 以上（Mac / Windows / Linux 共通）。

```bash
npm install
npm start   # http://localhost:5173
npm test    # 物理のテスト
```

## 構成

| ファイル | 役割 |
| --- | --- |
| `hull.js` | 船体形状・区画・開口部の定義（物理と描画の共通の元） |
| `sim.js` | 浮力・浸水・スロッシングの物理（Rapier） |
| `ship.js` / `textures.js` | 船の 3D モデルと手続き的テクスチャ |
| `fx.js` | 区画内の水・粒子・魚雷の視覚効果 |
| `main.js` | シーン・UI・ループ |
