# 资源生成用字体（不入库）

`NotoSansCJKsc-Regular.otf` 仅被 `scripts/generate-assets.mjs` 用于渲染
`public/prize.png` / `public/coat.png` 中的中文文字，属于离线构建辅助资源，
已通过 `.gitignore` 排除，不参与运行时打包。

如需重新生成占位图，先下载 SIL OFL 协议开源字体：

```bash
curl -sL \
  "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf" \
  -o scripts/assets/NotoSansCJKsc-Regular.otf
node scripts/generate-assets.mjs
```

运行时（刮刮卡页面）不依赖该字体，组件本身也不引用任何外部网络图片。
