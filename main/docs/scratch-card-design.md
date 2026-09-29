# 刮刮卡功能技术设计（Fabric.js v7）

> 本文档是后续实现的唯一依据：所有选型、数据结构、事件流、阈值时机、边界处理均已在此定稿，实现者不再需要做任何技术选型。
> 本文档只做设计，不含可运行代码；示例代码块均为**接口/伪代码约定**。

---

## 0. 版本核实与结论基准

- `package.json` 声明 `"fabric": "^7.4.0"`；`package-lock.json` 锁定解析结果为
  `node_modules/fabric: version 7.4.0`（`https://registry.npmjs.org/fabric/-/fabric-7.4.0.tgz`）。
- 本机当前尚未执行 `npm install`，所以工作区里暂无 `node_modules`；本文档所有结论基于
  **fabric@7.4.0 随包发布的 TypeScript 源码**（npm 包内含 `src/` 目录，安装后路径即
  `node_modules/fabric/src/...`，与本文引用路径一一对应）。
- 本文引用的源码路径一律写成 `node_modules/fabric/src/...`，并附行号，安装依赖后可直接核对。
  结论不得用 v5/v6 网络教程外推：v7 的分层 DOM、缓存、指针坐标与旧版差异已在第 2 章逐条以源码证实。

### 0.1 定稿架构（一句话）

**奖品层用 Fabric 渲染（`StaticCanvas` + 奖品 `FabricImage`）；银色涂层是一张独立的离屏
`<canvas>`，在其自身 2D 上下文里以 `destination-out` 擦除；该离屏 canvas 再作为一个
`FabricImage`（涂层对象）盖在奖品图之上。** 涂层对象全程只复用同一个 `<canvas>` 元素引用，
不调用 `setElement`、不新增/删除 Fabric 对象，每次刮擦后只 `requestRenderAll()`。

### 0.2 定稿 API 轮廓（实现时照此落地，非最终代码）

```ts
// src/scratch-card/ScratchCard.ts（下一轮实现；本轮不落盘）
interface ScratchCardOptions {
  el: HTMLCanvasElement;          // 页面中的 <canvas>，交给 new StaticCanvas(el, opts)
  prizeSrc: string;               // 底层奖品图（同源或带 CORS）
  coating?: string | HTMLImageElement | HTMLCanvasElement; // 涂层图案；缺省=纯银
  brushRadius?: number;           // 逻辑像素，默认 22
  revealRatio?: number;           // 自动全揭开阈值，默认 0.70
  gridSize?: number;              // 面积统计网格边长（逻辑像素），默认 8
  maxDpr?: number;                // 离屏涂层背板最大倍率，默认 2
  onProgress?: (ratio: number) => void;
  onReveal?: () => void;          // 达到阈值、自动揭开时回调，仅触发一次
}
class ScratchCard {
  constructor(opts: ScratchCardOptions);
  reset(): void;                  // 重新铺满涂层、清空笔画日志、重置状态机
  destroy(): void;                // 解绑监听、dispose StaticCanvas、释放离屏 canvas
  getProgress(): number;          // 当前刮开比例 0..1
}
```

图层（自底向上，全部在同一个 Fabric `StaticCanvas` 上）：

1. 奖品 `FabricImage`（`prizeImage`，铺满卡片逻辑尺寸 W×H）。
2. 涂层 `FabricImage`（`coatingImage`），其 `_element` 始终是离屏 `scratchCanvas`。

不使用交互版 `Canvas`：本功能没有对象选择/变换，交互版独有的上层 canvas、选择框、
分组选择器等全部是纯负担（证据见 2.1）。

---

## 1. 三条技术路线对比与选型

三条路线描述：

- **路线 A：`destination-out` 离屏画布（推荐）**
  独立离屏 canvas 先绘制银/图案涂层；每次指针移动在该离屏 ctx 上以
  `globalCompositeOperation = 'destination-out'` 画插值线段（只减 alpha）；
  离屏 canvas 作为一个 `FabricImage` 元素参与 Fabric 场景；每次改动后 `requestRenderAll()`。
  面积统计直接读该离屏 canvas 的 alpha 通道。
- **路线 B：倒置 `clipPath`**
  涂层对象/画布挂一个 `inverted: true` 的 clipPath，刮痕（Path/Brush 几何）作为 clipPath
  内容。Fabric 内部对倒置 clipPath 会用 `destination-out` 合成
  （`node_modules/fabric/src/shapes/Object/Object.ts:799-815`）。
- **路线 C：笔刷对象（free-drawing / EraserBrush）**
  开 Fabric 的 `isDrawingMode`，用 `PencilBrush`/`EraserBrush` 把刮痕作为 Fabric 对象
  不断 `add` 进画布；或每条刮痕生成一个 `Path`。

### 1.1 对比矩阵（4 维，10 分制；分数越高越好）

| 维度 | A：destination-out 离屏 | B：倒置 clipPath | C：笔刷对象 |
|---|---|---|---|
| 正确性 | **9**。擦除语义=“只减涂层 alpha”，与 Canvas 标准合成严格一致；奖品层从不参与擦除，不可能误擦；面积统计的数据源与视觉像素是同一块背板，口径天然一致 | 5。倒置 clipPath 在 v7 能得到“挖洞”效果，但：①画布级 clipPath 作用于**整个合成结果**而非单层（`StaticCanvas.renderCanvas` 在所有对象渲染完后统一执行 clipPath，`node_modules/fabric/src/canvas/StaticCanvas.ts:556-567`），会把奖品图一起裁掉，必须额外构造仅含涂层的隔离缓存；②依赖对象级缓存重建与 `inverted` 内部流程（`Object.ts:799-889`），几何越复杂越容易触发整层缓存重绘 | 4。`PencilBrush` 是 `source-over` 黑色笔画，语义上是“加墨”不是“擦除”（`node_modules/fabric/src/brushes/PencilBrush.ts:294` `canvas.add(path)`，`createPath` 用 `stroke: this.color`）；`EraserBrush` 才是擦除，但它**不在 v7 主包内**（见 1.2），且其 erasable/clipPath 模型是为“擦场景对象”设计，面积口径需要另算 |
| 性能 | **8**。擦除是单条 `stroke()` + 一次 `requestRenderAll`（rAF 合并，`node_modules/fabric/src/canvas/StaticCanvas.ts:491-506`）；Fabric 场景里常态只有 2 个对象，且 `FabricImage.shouldCache()` 默认不建对象缓存（`node_modules/fabric/src/shapes/Image.ts:630-632`、`node_modules/fabric/src/shapes/Object/Object.ts:770-778`），每帧就是两次 `drawImage`；面积读取走“网格降采样”，O((W·H)/g²) 且可 rAF 节流 | 4。clipPath 每帧走 `renderCache({forClipping:true})` + `drawClipPathOnCanvas`（`StaticCanvas.ts:556-600`），`drawClipPathOnCanvas` 内部还有一次 `save/transform/drawImage/restore`；刮痕每变化一次就要重建/失效 clipPath 缓存，复杂笔迹下 CPU 合成成本高 | 5。笔画增量期在 `contextTop` 上增量 `stroke()`（`SelectableCanvas.ts:417-431`、`PencilBrush.ts:100-124`）尚可；但每次抬手 `_finalizeAndAddPath` 都会 `canvas.add(path)` 触发整画布重渲染（`PencilBrush.ts:294` + `StaticCanvas.ts:225`），对象数随刮痕条数无界增长，长时交互后 `_renderObjects` 线性变慢（`StaticCanvas.ts:553` 调用、`_renderObjects` 定义于 `624-628`） |
| 内存 | **8**。离屏背板 1 张（W·H·dpr²·4 字节，dpr 封顶 2）+ 一份轻量笔画日志（仅折线点，用于 iOS 丢上下文重建/resize 重映射）；无 Fabric 对象膨胀 | 6。clipPath 需要额外缓存 canvas（`Object.ts:846-863` `createClipPathLayer`），随刮痕包围盒增长；刮痕几何也需常驻 | 3。每条刮痕一个 `Path` 对象 + 路径缓存，对象数=刮痕条数；v7 对象缓存 canvas 按对象包围盒分配（`Object.ts:683-701`），多笔迹内存随交互时长无界增长 |
| 与 v7 渲染管线兼容性 | **9**。只用稳定公共能力：`StaticCanvas`、`FabricImage`、`backgroundColor`/对象叠加、`requestRenderAll`。不碰上层 ctx、不改 clipPath、不依赖未导出模块；resize/DPR 全部走 `setDimensions` 官方路径 | 5。能跑通但要逆着管线分层假设用：画布 clipPath 是对整帧的（`StaticCanvas.ts:556-567`），需要把涂层放进隔离缓存层级才能只裁涂层，属“与管线对抗” | 4。必须用交互版 `Canvas` 及其双 canvas；`renderAll` 在非绘制模式会清空 `contextTop`（`SelectableCanvas.ts:396-404`），上层笔画是临时层、抬手才固化；`EraserBrush` 主包不导出（见 1.2），需要自行移植 mixin，锁死升级路径 |
| **合计** | **34 / 40（推荐）** | 20 / 40 | 16 / 40 |

### 1.2 为什么 Fabric 官方 free-drawing / eraser demo 的做法在本需求下不够用

源码事实：

1. **free-drawing 画的是“新墨迹”不是“挖洞”。** `PencilBrush.onMouseUp` →
   `_finalizeAndAddPath()` 把笔迹 `new Path(...)`（`stroke: brush.color`）`canvas.add(path)`
   进场景：`node_modules/fabric/src/brushes/PencilBrush.ts:260-302`。
   要的是“减少涂层 alpha”，`source-over` 描边无法实现。
2. **真正能擦除的 `EraserBrush` 不在 fabric@7.4.0 主包导出里。**
   它仅以源码 mixin 形式存在于 `node_modules/fabric/src/mixins/eraser_brush.mixin.ts`
   （该文件用 `inverted` clipPath 给对象挂 eraser），主入口聚合文件
   `node_modules/fabric/fabric.ts` 与产物 `dist/fabric.mjs` 中均无 `EraserBrush`
   （在 7.4.0 产物中检索 `EraserBrush` 命中数为 0）。用它等于自带一份内部 mixin 补丁，
   违背“决策完备、可平滑升级”的目标。
3. **笔刷临时层在每次 `renderAll` 时会被清掉。**
   `SelectableCanvas.renderAll()`：非 drawing 模式下
   `if (this.contextTopDirty ...) { this.clearContext(this.contextTop); }`
   （`node_modules/fabric/src/canvas/SelectableCanvas.ts:396-404`）。
   也就是说上层 canvas 上的笔迹不是持久像素，无法直接对它做稳定的面积读取，必须等抬手固化，
   与“实时面积统计 + 快速滑动连续笔迹”的实时性诉求冲突。
4. **面积口径对不上。** 官方 demo 关心“画了什么对象”，本需求关心“涂层还剩多少不透明像素”。
   对象/路径数量与剩余涂层像素没有换算关系；而路线 A 的面积读取对象就是用户看到的涂层背板。
5. **交互模型过重。** 官方 free-drawing 依赖交互版 `Canvas` 的上层 canvas、`contextTopDirty`、
   选择态清空等机制（`SelectableCanvas.ts:396-440`）。本功能只需要“按下—移动—抬起”，
   用 `StaticCanvas` + 自建指针监听即可，避免选择/变换/控件绘制等无关开销。

**结论：采用路线 A。** 路线 B 作为“Fabric 原生擦除”的备选被否（单层语义不成立、缓存抖动）；
路线 C 因语义相反、擦除模块未发布、对象无界增长被否。

---

## 2. Fabric.js v7.4.0 渲染管线分析（每条结论附源码证据）

### 2.1 `renderAll` 的上下文 save/restore 开销

调用链：`requestRenderAll`（rAF 去重）→ `renderAndReset` → `renderAll` →
`renderCanvas(ctx, objects)`：
- `node_modules/fabric/src/canvas/StaticCanvas.ts:465-469`（`renderAll`）
- `node_modules/fabric/src/canvas/StaticCanvas.ts:491-506`（`requestRenderAll`：
  已有 `nextRenderHandle` 则不再入队，天然 rAF 合并）
- `node_modules/fabric/src/canvas/StaticCanvas.ts:535-569`（`renderCanvas`）

`renderCanvas` 每帧的 save/restore 计数（按源码逐段核对）：

| 阶段 | save/restore | 源码 |
|---|---|---|
| 清空 + `before:render` + 背景 | 背景填充/背景图各 1 对 | `StaticCanvas.ts:437`（`clearRect`）、`StaticCanvas.ts:631-663`（`_renderBackgroundOrOverlay`：fill 分支 `632-650`、object 分支 `653-663`） |
| 应用 viewportTransform 渲染对象 | 1 对包住整个 `_renderObjects` | `StaticCanvas.ts:550-554`（`ctx.save(); ctx.transform(...vpt); ... _renderObjects ...; ctx.restore()`） |
| 每个对象 `render` | 每对象 1 对 | `node_modules/fabric/src/shapes/Object/Object.ts:662-676`（`ctx.save()` … `ctx.restore()`） |
| 画布 clipPath（本方案不使用） | 1 对 + 内部缓存 | `StaticCanvas.ts:556-567`、`583-600` |
| overlay | 与背景同结构 | `StaticCanvas.ts:653-663` |

结论：**在本方案“2 个对象、无背景填充对象、无 clipPath、无 overlay、viewportTransform 为单位阵”的稳态场景，每帧 save/restore 固定为：viewport 1 对 + 2 个对象各 1 对 ≈ 3 对**，外加一次整画布 `clearRect` 与两次 `drawImage`。该成本在移动端 60fps 预算内可忽略，**真正的成本不在 save/restore，而在涂层的全屏 `drawImage`**。因此优化重点是：避免给涂层对象开对象缓存（多一张全屏背板）、避免频繁整帧重绘（用 `requestRenderAll` 的 rAF 合并，而不是每次 pointermove 同步 `renderAll`）。

补充：交互版 `Canvas` 还会维护上层 canvas，`renderTopLayer` 内部再有 1 对
save/restore（`node_modules/fabric/src/canvas/SelectableCanvas.ts:417-431`），且
`renderAll` 可能执行 `clearContext(contextTop)`（`SelectableCanvas.ts:396-404`）。
本方案选 `StaticCanvas`，这部分开销与状态全部不存在。

### 2.2 两条“把擦除结果喂给 Fabric”的路径，哪条会与 dirty 机制失效

两条候选路径：

- **路径①：向 canvas 加对象**——每段刮痕 `canvas.add(path/brushObject)`。
- **路径②：外部 canvas 画线后 `setElement`**——在独立 `<canvas>` 上画，再调用
  涂层 `FabricImage.setElement(externalCanvas)`。

先看 v7 对象缓存/dirty 机制：

- 对象默认 `objectCaching: true`（`node_modules/fabric/src/shapes/Object/defaultValues.ts:88`）。
- 只有通过 `set()` 修改且 key 命中该类 `cacheProperties` 时才置 `dirty = true`
  （`node_modules/fabric/src/shapes/Object/Object.ts:610-618`）。
- 渲染时：`shouldCache()` 为真才走 `renderCache()`，且 `renderCache` 仅在
  `isCacheDirty()` 为真时重绘缓存（`Object.ts:649-701`、`911-933`）。

**路径②的失效风险（明确成立，需规避）：**

1. `FabricImage.setElement(element, size)` 只做：移除纹理缓存键、替换 `_element/_originalElement`、
   `_setWidthHeight(size)`、按需跑滤镜；**它本身不设置 `dirty`**
   （`node_modules/fabric/src/shapes/Image.ts:238-253`）。
2. `FabricImage` 覆写了 `shouldCache()`，默认返回 `needsItsOwnCache()`；无 clipPath、无
   “stroke+fill+shadow 同时存在”时返回 **false**，即图像对象默认**不建对象缓存**，每帧
   `drawObject` 直接 `drawImage(_element)`（`Image.ts:630-632`；`Object.ts:750-763`；
   `Image._renderFill` 的 `drawImage` 在 `Image.ts:634-662`）。
   - 推论：纯图场景下，即使 `setElement` 不置 dirty，只要触发一次 `renderAll`，
     画面仍会拿到新像素（因为根本没缓存可复用）。**但这是“侥幸正确”**：一旦涂层对象被设了
     `clipPath` / 滤镜 / 特定 shadow（`needsItsOwnCache()` 变 true，`Object.ts:750-763`），
     由于 `setElement` 不置 dirty，缓存层 `isCacheDirty()` 返回 false，**屏幕将停留在旧涂层**
     （`Object.ts:683-701`）——这正是“外部画线 + setElement 与 dirty 检查配合失效”的具体形态。
   - 另外，`setElement` 默认会用传入 canvas 的像素尺寸重算对象 `width/height`
     （`_setWidthHeight`，`Image.ts:243`、`687-692`）：在 DPR 背板（物理像素 = 逻辑像素×dpr）下
     会把涂层对象的几何尺寸放大 dpr 倍，需要每次显式传逻辑 `{width,height}` 才能纠正，属于易错的隐式行为。
   - 文档注释本身也提示：替换后“可能需要手动 `canvas.renderAll` 与 `object.setCoords`”
     （`Image.ts:230-237`）。

**路径①的问题（语义与增长，非 dirty 失效）：**

- `add()` 成功且 `renderOnAddRemove`（默认 true，
  `node_modules/fabric/src/canvas/StaticCanvasOptions.ts:170`）时会 `requestRenderAll()`
  （`node_modules/fabric/src/canvas/StaticCanvas.ts:223-227`），所以 dirty 上“看起来能更新”；
- 但它把“擦除像素”错误建模成“持续增加的对象集合”，对象数随刮痕条数无界增长（见 1.1
  性能/内存行），且 `source-over` Path 语义不是擦除。

**定稿做法（同时规避两条路径的坑）：**

- 涂层 `FabricImage` 在构造时就直接传入那张离屏 `scratchCanvas`，之后**永远不调用
  `setElement`、永远不 add/remove 任何刮痕对象**——`_element` 引用恒定。
- 每次擦除只修改离屏 canvas 的像素，再调用一次 `coatingImage.canvas.requestRenderAll()`
  （即 StaticCanvas 的 rAF 合流入口，`StaticCanvas.ts:491-506`）。
- 由于涂层是纯 `FabricImage`、`shouldCache()` 默认 false（`Image.ts:630-632`），下一帧
  `renderCanvas → image.render → drawObject → drawImage(scratchCanvas)` 必然读取最新背板，
  不经过对象缓存，**从结构上消除“setElement 不置 dirty 导致缓存陈旧”的失效面**。
- 额外防御（成本极低，写进实现 checklist）：若未来给涂层加了 clipPath/滤镜/shadow，必须在
  `requestRenderAll` 前显式 `coatingImage.set('dirty', true)`（`set` 对任意键都会写入；
  命中 cacheProperties 才自动置 dirty，见 `Object.ts:610-618`）。当前定稿配置下不触发该分支。

### 2.3 `enableRetinaScaling` 开启时的尺寸缩放关系，面积统计读哪个像素空间

默认开启：`enableRetinaScaling: true`
（`node_modules/fabric/src/canvas/StaticCanvasOptions.ts:172`）。

- 倍率来源：`getRetinaScaling() = enableRetinaScaling ? getDevicePixelRatio() : 1`
  （`node_modules/fabric/src/canvas/StaticCanvas.ts:271-273`）；
  `getDevicePixelRatio()` 取 `window.devicePixelRatio`，下限为 1
  （`node_modules/fabric/src/env/index.ts:46-47`）。
- 物理 vs 逻辑尺寸：`setCanvasDimensions` 先把 `el.width/height` 设为逻辑 W/H，
  当 retinaScaling>1 时**再改写属性**为 `W*r × H*r`，并执行一次 `ctx.scale(r, r)`
  （`node_modules/fabric/src/canvas/DOMManagers/util.ts:9-21`）。
  CSS 尺寸单独由 `setCSSDimensions` 写 `style.width/height`（同文件 `:24-31`），
  由 `setDimensions` 在非 backstoreOnly 时调用（`StaticCanvas.ts:303-323`）。
  于是：**backing store = 逻辑像素 × dpr；ctx 基础变换 = scale(dpr,dpr)；Fabric 场景坐标、
  `this.width/height`、对象几何一律是逻辑像素；CSS 尺寸 = 逻辑像素。**
- v7 指针坐标也在框架内做了 dpr 还原：`_getPointerImpl` 先减偏移、按 viewportTransform 反算，
  再 `pointer.x /= retinaScaling`，最后用 `upperCanvasEl.width / boundsWidth` 修正 CSS 缩放
  （`node_modules/fabric/src/canvas/SelectableCanvas.ts:1060-1098`）。

**离屏涂层背板的定稿空间（关键决策）：**

- `scratchCanvas.width = round(W * s)`、`height = round(H * s)`，
  其中 `s = min(window.devicePixelRatio, maxDpr)`，`maxDpr` 默认 **2**（超 2 的 DPR 肉眼几乎无差，
  省一半以上像素填充与读取成本）。
- 绘制/擦除坐标统一用**物理像素**：ctx 不调用 `setTransform`/`scale`，保持单位阵；
  从框架/原生事件拿到的逻辑坐标 `(x,y)` 乘以 `s` 后再画线。这样背板自身不依赖任何
  Fabric 变换，Fabric 每次 `drawImage` 只是把它整体映射到逻辑 W×H。
- **面积统计必须读取 `scratchCanvas` 自身的 backing-store 像素空间（W·s × H·s），
  绝不读 Fabric lower canvas 的 CSS/逻辑空间。** 理由：
  1. 口径独立于 Fabric 是否开 retina——读涂层背板时 alpha 分布就是视觉结果的唯一真值；
  2. 若读 lower canvas，会把奖品图、dpr scale、合成顺序全部卷入，透明像素无法区分“被刮开”
     与“本来无内容”；
  3. 分母用“涂层覆盖区域的总采样点数”，而非整张卡像素，保证矩形卡与任意涂层图案口径一致。
- 注意：**不要在创建 `scratchCanvas` 的 2D context 时传 `willReadFrequently: true`。**
  该 context 是每帧 `drawImage` 合成的热路径（硬件加速更重要），读取走 2.3/第 3 章的
  降采样独立小 canvas 或抽样读取。Fabric 自己也只对专门用于命中检测的
  `pixelFindContext` 使用 `willReadFrequently`
  （`node_modules/fabric/src/canvas/SelectableCanvas.ts:1118-1125`），可佐证“读取专用上下文”
  才是该选项的正确用法。

### 2.4 `destination-out` 到底在哪个 ctx 生效；直接操作 Fabric 顶层 canvas 会怎样

- `destination-out` 的标准语义：以新绘制形状的 alpha 为“橡皮擦”，只降低目标 canvas 现有像素的
  alpha（源像素本身不落色）。本方案**仅在 `scratchCanvas.getContext('2d')` 这一个上下文**设置
  `globalCompositeOperation = 'destination-out'`，画完立即复位为 `'source-over'`。
  Fabric 内部对倒置 clipPath 用的也是同一合成操作，可作为语义旁证：
  `node_modules/fabric/src/shapes/Object/Object.ts:799-815`
  （`inverted ? 'destination-out' : 'destination-in'`）。
- 该擦除**绝不发生在 Fabric 的 lower/upper ctx 上**：
  - lower ctx 每帧 `renderCanvas` 一开始就 `clearRect` 全清并重绘背景与全部对象
    （`StaticCanvas.ts:437`、`535-554`）。任何直接写在 lower canvas 上的擦除像素都会在下一帧
    被无条件抹掉；而且若在 lower ctx 上 `destination-out`，被减 alpha 的是“整帧合成结果”，
    会连奖品图一起抠穿，露出页面背景，而非露出奖品。
  - 交互版 upper ctx（`contextTop`）在每次非绘制模式 `renderAll` 时也会被清空
    （`SelectableCanvas.ts:396-404`；`renderTop` 每次还先 `clearContext`，
    `SelectableCanvas.ts:436-440`），同样不持久。
- 因此“直接操作 Fabric 顶层 canvas 元素”的两个具体后果：
  1. **下一帧丢失**：`renderCanvas` 的整画布 `clearRect` 与重绘覆盖它；
  2. **作用对象错误**：`destination-out` 作用于当前已合成帧，无法做到“只擦涂层、不碰奖品”。
- 反过来，Fabric 把 `scratchCanvas` 当普通图像源 `drawImage` 时使用默认 `source-over`
  （对象级 `globalCompositeOperation` 默认 `'source-over'`，
  `node_modules/fabric/src/shapes/Object/defaultValues.ts:82`，在
  `Object._setupCompositeOperation` 应用，`Object.ts:1483-1487`），涂层自身的透明孔洞
  在这一步被正常合成，露出下层奖品——**擦除与显示严格分离，互不污染**。

---

## 3. 面积统计、快速滑动插值与回调去重

### 3.1 三种统计算法对比与选型

所有方案的统计空间都相同：离屏 `scratchCanvas` 的 backing store（见 2.3）。
记物理尺寸 `PW = round(W·s)`、`PH = round(H·s)`，总像素 `N = PW·PH`。

| 方案 | 做法 | 精度 | 单次耗时 / 内存 | 评定 |
|---|---|---|---|---|
| 全量 `getImageData` | 每帧读整屏，遍历 alpha 统计 | 精确（逐像素） | O(N) 时间；产生 N×4 字节临时缓冲（如 390×400、s=2 ≈ 250 万字节），频繁调用造成明显 GC 与主线程抖动 | 仅作“仲裁”，不作逐帧主路径 |
| **网格降采样（选定）** | 以 `grid = round(gridSize·s)` 为步长（`gridSize` 默认 8 逻辑像素），读取每行/每列抽样点的 alpha；或把背板 `drawImage` 缩到约 (PW/grid)×(PH/grid) 的只读小 canvas 再全量读 | 对“远大于网格的连续刮痕”误差极小（理论抽样误差随网格减小迅速收敛，默认参数目标误差 < 1 个百分点） | O(N/grid²)；390×400@2 时采样点约 (98×100) ≈ 1 万级，单帧亚毫秒；只读小 canvas 常驻一张 | **主路径** |
| 增量计数 | 擦除前读取每个笔刷卡住区域的 alpha，统计“本次由不透明变透明”的像素数并累加 | 在无重绘/无 resize 时精确 | 需要对每个 stroke 段做局部 `getImageData`（段长×笔刷直径），实现复杂；reset、resize、iOS 丢上下文重建后计数基线会失配，必须周期性全量校准 | 收益相对网格不大、失效面多，**本期不采用**，仅在性能实测不达标时作为后续优化 |

**定稿混合策略（兼顾精度与性能）：**

1. 逐帧（rAF 节流，见 3.3）用网格降采样算 `ratio = cleared / totalSamples`。
2. 当 `ratio` 进入阈值邻域 `[revealRatio − 0.03, revealRatio + 0.03]` 时，
   **追加一次全量 `getImageData` 仲裁**（只在临界小区间触发，整局通常 0–2 次），
   以仲裁值决定是否跨过 70%，消除抽样在临界点的抖动。
3. 统计口径的“涂层总样本”：若涂层是矩形满铺，`totalSamples = 采样点总数`；若支持异形涂层，
   初始化时对完整背板做一次采样建立 `coatingMask`（是否原为不透明），分母只统计 mask 内点，
   `cleared` 统计 mask 内 `alpha < alphaCut`（`alphaCut = 16`，抗边缘抗锯齿）的点。
4. 读取方式优先用“只读小 canvas”：
   `readCtx.drawImage(scratchCanvas, 0,0, PW,PH, 0,0, cw,ch)` 后 `getImageData(0,0,cw,ch)`，
   避免直接给热背板 context 加 `willReadFrequently`（见 2.3）。同源 canvas 互 draw 不触发
   canvas 安全异常。

### 3.2 快速滑动的插值补点（伪代码定稿）

要点：**相邻事件点之间画连续实线线段 + 圆头线帽**，而不是画离散圆点。只要单次事件间隔内
位移不超过 `2×brushRadius`，线段之间没有空隙；即使极端快速滑动（事件稀疏、两点相距远超笔刷宽），
线段本身仍把两点连成一条连续走廊（round cap 保证端点也是半圆），不会断成虚线。另在每段
长度异常大（>阈值，例如 64 逻辑像素，常见于事件丢失/跳出）时，沿线段按 `step ≈ brushRadius`
补点，保证统计与边缘一致性，并约束补点密度。

```text
state:
  drawing: Boolean
  last: {x, y}                 // 逻辑像素（Fabric 坐标空间）
  brushRadiusLogical = 22      // 可配置
  MAX_GAP = 64                 // 逻辑像素，超过则显式补点
  scratchCtx                   // scratchCanvas 的 2d ctx，单位阵，物理像素空间
  scale = min(dpr, maxDpr)

onPointerDown(p):                 // p 为逻辑像素坐标
  drawing = true
  last = p
  schedRender()                   // 见 3.3
  paintDot(p)                     // 仅一个点也能出洞

onPointerMove(p):
  if not drawing: return
  enqueuePoint(now, p)            // 先入队，实际绘制在 rAF 内做
  schedRender()

onPointerUp / onPointerCancel(p):
  drawing = false
  flushSegment()                  // 把残余点画完
  computeProgress(forceFullIfNearThreshold = true)

# rAF 回调（每帧最多一次；一帧内的多个事件点在同一帧顺序连线）
frame():
  pts = drainQueue()              # 本帧全部逻辑点（可能很多）
  prev = last
  for q in pts:
      strokeSegment(prev, q)
      prev = q
  last = prev
  computeProgress(forceFullIfNearThreshold = false)

strokeSegment(a, b):
  dist = hypot(b - a)
  if dist < 0.5: paintDot(b); return
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.lineCap = 'round'
  scratchCtx.lineJoin = 'round'
  scratchCtx.lineWidth = brushRadiusLogical * 2 * scale
  scratchCtx.beginPath()
  scratchCtx.moveTo(a.x*scale, a.y*scale)
  if dist > MAX_GAP:
      # 事件极度稀疏：沿直线补点，形成无间断走廊
      steps = ceil(dist / MAX_GAP)
      for k in 1..steps:
          m = lerp(a, b, k/steps)
          scratchCtx.lineTo(m.x*scale, m.y*scale)
  else:
      scratchCtx.lineTo(b.x*scale, b.y*scale)
  scratchCtx.stroke()
  scratchCtx.globalCompositeOperation = 'source-over'
  appendStrokeLogSegment(a, b)    # 归一化坐标，供 iOS 重建 / resize 重映射（见 4.4、4.5）

paintDot(p):
  # 用 arc 填一个半径=笔刷半径的圆，保证“点按”也是完整圆形洞
  ... destination-out; arc(p.x*scale, p.y*scale, brushRadiusLogical*scale); fill()
```

说明：v7 的 `PencilBrush` 增量绘制同样依赖 `lineCap/lineJoin` 与连续 `quadraticCurveTo`
（默认 `strokeLineCap='round'`、`strokeLineJoin='round'`，
`node_modules/fabric/src/brushes/BaseBrush.ts:30-40`；增量段在
`PencilBrush.onMouseMove` 中直接 `moveTo/quadraticCurveTo/stroke`，
`node_modules/fabric/src/brushes/PencilBrush.ts:100-124`），可佐证“连续线段+圆头”是
v7 下保证笔迹连续的正确手法；本方案的差别只在合成模式（`destination-out`）与绘制宿主
（离屏 ctx 而非 `contextTop`）。

### 3.3 触发节奏与阈值跨越去重

- **渲染节流**：pointermove 只入队，绘制与统计放进单个 rAF 任务；渲染调用
  `staticCanvas.requestRenderAll()`（该方法对同一帧内的多次调用天然去重，
  证据 `StaticCanvas.ts:491-506`），不要同步 `renderAll()`。
- **状态机（防止重复触发回调）**：
  - `phase: 'covering' | 'revealing' | 'revealed'`
  - `covering`：正常刮擦、逐帧统计。
  - 当且仅当仲裁后的 `ratio >= revealRatio(0.70)` 且当前为 `covering`：
    1. 原子地 `phase = 'revealing'`（先翻状态，再做副作用，杜绝同一帧/重入再次进入）；
    2. 解绑/短路指针刮擦输入；
    3. 执行“自动全揭开”：对 `coatingImage` 做 200–250ms 淡出（Fabric animate `opacity → 0`），
       动画结束 `coatingImage.visible = false`（隐藏后 `render()` 直接返回，
       `Object.ts:637-656`（`isNotVisible` 于 637、`render` 早退于 651-653）），并将 `scratchCanvas` 从渲染树解耦；
    4. 淡出结束 `phase = 'revealed'`，触发一次 `onReveal()`。
  - **保证 `onReveal` 全局只触发一次**：除状态机外，再设布尔锁 `revealFired`；
    `reset()` 同时复位 `phase='covering'`、`revealFired=false`。
  - `onProgress(ratio)` 可每帧回调（已在 rAF 节流内），但 70% 的“越线判定”只认临界全量仲裁值。
- **抖动防护**：进入 `[0.67,0.73]` 才做全量仲裁；低于 0.67 只用网格值。这样既不会因抽样
  高估提前触发，也不会在阈值附近反复全量读取。

---

## 4. 边界清单（逐条给出定稿处理）

### 4.1 多点触控

- v7 交互版用 `_isMainEvent`（`PointerEvent.isPrimary` / `mainTouchId`）只跟踪“主触点”
  （`node_modules/fabric/src/canvas/Canvas.ts:602-617`）。本方案用 `StaticCanvas`，自建指针
  管理，定稿支持**多指同时刮**：
  - 维护 `Map<pointerId, {x,y, active}>`，在 `pointerdown` 建立、`pointerup/cancel` 删除；
  - 每个活跃指针各自保存 `last`，`pointermove` 按 `event.pointerId` 找到对应笔画做
    `strokeSegment`；同一 rAF 内按事件顺序串行画到同一个 `scratchCtx`（2D ctx 串行无竞争）。
- **必须用 Pointer Events**：在承载元素的容器/upper 占位元素上设置 `touch-action: none`
  （Fabric 交互版也是这么做以阻止滚动：`node_modules/fabric/src/canvas/DOMManagers/CanvasDOMManager.ts:92`），
  并在 `pointerdown` 时 `setPointerCapture(pointerId)`，把后续 move/up 稳定收归到元素。
- 不使用 v7 的 mouse/touch 双轨监听（`enablePointerEvents` 默认 false 时 Fabric 走
  `touchstart/touchmove` 老路径，`node_modules/fabric/src/canvas/CanvasOptions.ts:284`、
  `Canvas.ts:193`、`620-672`），本方案与 Fabric 事件系统解耦，直接用原生 Pointer Events，
  避免其“主触点唯一”语义把第二指刮擦丢弃。

### 4.2 指针移出画布再移回的笔迹连续性

- 拖拽期间的 move/up 监听挂在 `window/document` 上（v7 自己在 down 后也是把 move/up 切到
  document 以保证移出后仍能收到：`node_modules/fabric/src/canvas/Canvas.ts:684-693`）。
  本方案等价做法：`setPointerCapture` 为主，同时在 `pointerdown` 后于 window 上兜底监听
  `pointermove/pointerup/pointercancel`，up 时解绑。
- 坐标处理：对超出卡片范围的点**裁剪到边界矩形**（clamp 到 `[0,W]×[0,H]`）后再连线，
  使得“从卡内移出、沿卡外滑动、再移回卡内”时，卡内边缘形成连续走廊，回到卡内笔迹无缝衔接；
  不因为 out-of-range 而丢弃点或重置 `last`。
- 不依赖 Fabric 的 `pointer:out/enter`（StaticCanvas 没有这些交互处理）。

### 4.3 iOS Safari 的 `getImageData` 行为

- 同源图片/自绘 canvas 不污染画布，`getImageData` 不抛 `SecurityError`。**奖品图与涂层图案
  必须同源或正确配置 CORS**（`<img crossorigin="anonymous">` + 服务端 `Access-Control-Allow-Origin`），
  否则一旦把跨域未授权图像绘制进 canvas，后续 `getImageData` 会抛安全异常，统计直接失效。
  实现上在图片 `onload/onerror` 包一层加载器，CORS 失败降级为纯色涂层并上报。
- iOS Safari（尤其内存紧张时）对后台/离屏 canvas 也可能做 **backing store 回收**；旧版 WebKit
  历史上对 2D canvas 没有可靠的 `contextlost` 事件（与 WebGL 不同，Fabric 对 WebGL 后端有
  `webglcontextlost` 处理，见 `node_modules/fabric/src/filters/WebGLFilterBackend.ts:89`，
  对 2D 上下文无对应机制可依赖）。定稿的稳健方案见 4.4：**笔画日志为唯一可重建事实源**，
  检测到背板被清空就整层重放。
- 读取性能：iOS 上对大背板频繁全量 `getImageData` 代价高，严格走 3.1 的网格/小 canvas 降采样，
  临界才全量；并在非交互帧（无新笔画）不重复读取，复用上一帧 `ratio`。

### 4.4 页面切走（tab 隐藏 / 锁屏 / 内存回收）后重绘丢失

- Fabric 自身只在“尺寸变更”时把 `hasLostContext=true`，并在下一次交互版 `renderAll` 时
  重绘上层（`node_modules/fabric/src/canvas/StaticCanvas.ts:314`、
  `SelectableCanvas.ts:405-408`）；它能重建 Fabric 对象层（奖品图、涂层对象都能由
  `drawImage` 重画），**但重建不出我们在离屏 `scratchCanvas` 上用 destination-out 擦掉的
  alpha**——那些擦除只存在于离屏背板像素里，一旦被系统回收就永久丢失。
- 定稿兜底：
  1. 监听 `document.visibilitychange`（隐藏→恢复）与 `window.pageshow`；
  2. 恢复时做“背板活性探针”：读取 `scratchCanvas` 一个已知应不透明（角落）和一个由笔画日志
     推断应为透明的点的 alpha；若发现本应有内容却全 0（背板被清空），判定为丢失；
  3. **重建**：重新把原始涂层图案绘制到 `scratchCanvas`（铺满），然后按笔画日志
     （归一化坐标，见 4.5）重放全部 `strokeSegment`，再 `requestRenderAll()`；
  4. 无论是否丢失，都触发一次 `requestRenderAll()`，确保 Fabric 对象层也在回到前台后刷新。
- 笔画日志压缩：只存折线拐点（相邻点距离 < 1 逻辑像素不入日志）、坐标归一化到 0..1、
  笔宽/圆头参数固定；常规一局（几十笔）日志在 KB 级，重建耗时为一遍 stroke，可接受。
  reset 时清空日志。

### 4.5 resize / DPR 变化后的坐标系重映射与状态保持

- 用 `ResizeObserver` 观察卡片容器，rAF + 200ms 去抖；另监听
  `window.matchMedia(`(resolution: ${oldDpr}dppx)`)` 的变化以捕获 DPR 改变
  （zoom、跨屏拖动）。
- **状态保持的事实源是“归一化笔画日志”，不是任何具体尺寸的背板**：
  - 所有日志点存 `(nx, ny) ∈ [0,1]`（`nx = x / W`），笔宽按当前逻辑尺寸实时换算
    （`brushRadiusLogical` 以逻辑像素配置，必要时按卡片短边比例缩放，本期固定逻辑像素）。
  - resize 时：① `staticCanvas.setDimensions({width:newW, height:newH})`（官方路径，
    会同时重设 lower backing、CSS 与 `hasLostContext`，并 `calcOffset`，
    证据 `StaticCanvas.ts:303-323`、`canvas/DOMManagers/CanvasDOMManager.ts:96-105`）；
    ② 同步更新奖品与涂层 FabricImage 的 `width/height`（用 `set('width',..)`，命中
    cacheProperties，虽然图片默认不缓存也无害，`Object.ts:611-618`、
    `shapes/Object/defaultValues.ts:34-44`）；③ 以新 `s = min(dpr,maxDpr)` 重开
    `scratchCanvas.width/height`（注意：改 width 属性会清空内容），重铺涂层并按归一化日志
    重放；④ `requestRenderAll()`。
  - 这样 resize 前后刮开区域在视觉上等比例迁移，**状态不丢失**；进行中拖拽遇到 resize
    （罕见）时，活跃指针的 `last` 也按比例映射：`x' = nx·newW`。
- Fabric 的 `_onResize` 只做 `calcOffset()` 与事件缓存重置，不会替我们改尺寸/重放
  （`node_modules/fabric/src/canvas/Canvas.ts:794-797`；StaticCanvas 无自动尺寸跟踪），
  所以 resize 必须由本组件显式编排。

---

## 5. 风险清单（按 概率 P × 影响 I 排序；每条附最小证实/证伪实验）

评分：P、I 各 1–5，R = P×I。实验均要求在不引入新依赖的前提下完成（用 v8/手机浏览器手测或
最小静态页即可）。

| # | 风险 | P | I | R | 最小实验（证实/证伪）与对策 |
|---|---|---|---|---|---|
| R1 | 全屏 `drawImage` 涂层在低端机每帧重绘导致刮擦掉帧 | 3 | 4 | 12 | 用 390×400、s=2 背板，在 Chrome DevTools CPU 4× 节流 + 实机 iOS Safari 上做 30s 快速划动，录 rAF 帧间隔。若 P95 > 18ms：①确认未给涂层开对象缓存（应只 2 次 drawImage/帧）；②把 `requestRenderAll` 的区域收敛为按脏矩形局部刷新（离屏背板仍全量，Fabric 侧用脏矩形 imageRender），或对涂层改用与 lower canvas 尺寸一致的背板降低填充倍率；③`maxDpr` 降到 1.5 |
| R2 | 网格抽样在 70% 临界出现误判（提前/滞后触发） | 3 | 4 | 12 | 构造“刚好 69%/70%/71%”的合成背板（程序化抠洞），比较网格值与全量值偏差分布（≥50 组随机图案）。偏差超 ±2% 则缩小 `gridSize` 至 4 或扩大临界全量仲裁窗口至 ±5%。定稿已有“临界全量仲裁 + alphaCut=16”双保险，预期证伪 |
| R3 | iOS Safari 后台回收离屏 canvas，回前台刮痕消失 | 3 | 4 | 12 | 实机：刮至约 40%→切后台/锁屏 30s 与 10min 两档→回前台观察；用 4.4 的探针检测并验证“重铺+日志重放”恢复一致。若探针不可靠（部分回收），改为回前台**无条件重放一次**（成本仅一遍 stroke） |
| R4 | 极快滑动/事件稀疏时出现断点或尖角空隙 | 3 | 3 | 9 | 用注入合成事件（两点间隔 100/200/400px）在真机与桌面验证线段连续性；肉眼+截图像素检查相邻段是否有未透明缝隙。`round` cap/join + `MAX_GAP` 补点应消除；若仍有缝隙，把补点步长收紧到 `0.5×brushRadius` |
| R5 | 跨域奖品/涂层图触发 canvas 污染，`getImageData` 抛异常 | 2 | 4 | 8 | 分别用同源、允许 CORS、禁止 CORS 三类图加载后 `getImageData`，验证加载器能捕获并降级纯银涂层；文档明确部署侧 CORS 要求。对策：加载期 `crossOrigin='anonymous'` + try/catch 统计调用兜底 |
| R6 | resize/旋转（orientation change）后坐标错位或进度归零 | 3 | 3 | 9 | 桌面拖拽窗口宽度 320→768→320、手机横竖屏切换、浏览器缩放(dpr 变化)三场景，检查刮痕按比例迁移、`getProgress()` 单调不跳变。归一化日志重放方案应通过；失败则排查是否误用了物理像素存日志（必须存 0..1） |
| R7 | `onReveal` 重复触发（临界抖动/多指/动画重入） | 2 | 3 | 6 | 在约 70% 处反复来回刮（已揭开处边缘抖动不可再增 alpha，属天然单向）；在 reveal 动画进行中继续派发 move/up；断言回调计数恒为 1。状态机先翻 `revealing` + `revealFired` 双锁应通过；再加 `requestAnimationFrame` 内同步翻转杜绝重入 |
| R8 | 多指时第二指被忽略或笔画串线 | 2 | 3 | 6 | 真机双指同时快速划不同轨迹，检查两条独立走廊且无连线穿插。按 pointerId 分桶各自 last 应通过；`setPointerCapture` 多指针兼容性用 iOS/Android 双端确认 |
| R9 | 重置后内存/监听泄漏，多次 reset 后帧率下降 | 2 | 3 | 6 | 连续 reset 200 次前后对比堆内存快照（Performance/Memory）与帧时间；断言 window 上无残留监听、scratchCtx 状态复位、`phase/revealFired` 归位、日志清空。必要时 `scratchCanvas` 复用而非重建 |
| R10 | DPR>2 设备上背板过大（内存/首次绘制耗时） | 2 | 3 | 6 | 在 DPR=3 设备检查实际背板是否被 `maxDpr=2` 封顶，记录首次 `drawImage` 耗时与内存；边缘锐利度可接受即保留 2，否则提供“高分辨率模式”配置到 3 |
| R11 | 涂层图案含透明像素时面积口径偏大（把图案镂空算作已刮） | 2 | 2 | 4 | 用带透明文字/透明边距的涂层图初始化，检查 `coatingMask` 分母是否只统计初始不透明点；未建 mask 会高估进度。对策已定：初始化采样建立 `coatingMask` |

---

## 6. 人工验收用例表

前置：构建后在真机/模拟器与桌面 Chrome 同时执行；卡片参考逻辑尺寸 390×400 CSS px。
每条均给出操作与可判定的通过标准。

| # | 用例 | 前置/取值 | 操作步骤 | 通过标准 |
|---|---|---|---|---|
| AC1 | DPR=1 基础刮除与清晰度 | 桌面 Chrome，DevTools 强制 DPR=1（或普通 1x 显示器） | 慢速画圈、点按各一次 | 孔洞边缘为平滑圆形，无锯齿异常；露出的奖品图与涂层边界清晰；`getProgress` 单调上升 |
| AC2 | 高 DPR 清晰度 | 真机 iPhone（DPR≈3）或 DevTools DPR=3 | 观察未刮涂层文字/图案；慢速刮一条直线 | 涂层图案锐利；背板实际倍率被封顶为 2（可在调试日志确认 `s=2`）；刮痕边缘无明显模糊/马赛克 |
| AC3 | 快速滑动笔迹连续 | 任意设备，用触控或鼠标快速来回横扫 10 次，制造稀疏事件 | 观察笔迹；必要时截图放大 | 笔迹是连续带状，**无断成虚线/孤立圆点**；极端大跳变处也由补点连成走廊 |
| AC4 | 70% 阈值自动全揭开 | 新一局 | 持续刮到约 70% | 到达瞬间涂层在 200–250ms 内淡出到完全可见奖品；`onReveal` 触发**恰好 1 次**；揭开后继续触摸不再产生擦除 |
| AC5 | 阈值临界不抖动 | 新一局 | 刮到 68%→停顿→再补到 70% 附近，临界处反复小范围移动 | 未到 70% 不揭开；一旦越过不回弹；`onProgress` 数值平滑、无在 0.70 上下频繁跳变 |
| AC6 | 重置再刮 | 已刮到部分/已完全揭开 | 调用 `reset()` 后重新刮 | 涂层完整重新铺满（含原图案）；进度归零；可再次刮并再次在 70% 触发回调；重置后 `onReveal` 仍只触发一次 |
| AC7 | resize 状态保持 | 刮到 30%–50% | 桌面拖拽改变容器宽度；手机横竖屏切换 | 不刷新页面，已刮区域按比例迁移、内容不丢失；resize 后可继续刮，进度延续而非归零；笔迹/奖品不变形 |
| AC8 | 多指刮除 | 触屏设备 | 两指同时在不同区域快速划动 | 两根手指都产生连续独立刮痕，互不丢失、无错误连线；进度按总刮开面积增长 |
| AC9 | 移出再移回连续 | 鼠标/触控 | 按下后移出卡片外沿滑动再移回 | 卡内边缘刮痕连续，移回后笔迹无缝衔接，松手后状态正常（无“拖拽卡住”） |
| AC10 | 页面切走恢复 | 刮到约 40% | 切后台/锁屏数十秒后回前台（iOS 必测） | 已刮区域仍在（4.4 重放生效）；可继续刮并正常到达 70%；无整块涂层消失或统计异常 |
| AC11 | 自定义图案涂层 | `coating` 传入印“再来一次”的图片 | 初始展示并刮开 | 图案正确铺满/按设计重复（本期定稿满铺 `drawImage` 拉伸，不做 Pattern repeat）；刮除语义与纯银一致 |
| AC12 | 纯银默认涂层与销毁 | 不传 `coating`；用完调用 `destroy()` | 刮至揭开；创建/销毁多实例 | 默认金属银涂层可用；销毁后无 window/document 残留监听、无重复 rAF、无控制台报错 |

---

## 附录 A：实现 checklist（下一轮照单落地）

1. `new StaticCanvas(el, { width, height, backgroundColor: 'transparent', enableRetinaScaling: true, renderOnAddRemove: true })`；**不** `new Canvas(...)`。
2. 奖品 `new FabricImage(prizeImg, { left:0, top:0, originX:'left', originY:'top', width:W, height:H })`；涂层 `new FabricImage(scratchCanvas, { 同样左上原点、逻辑 W/H })`；`canvas.add(prize, coating)`，之后对象集合恒定。
3. 离屏 `scratchCanvas`：物理尺寸 `W·s × H·s`（`s=min(dpr,2)`），ctx 单位阵；初始铺涂层（纯银或图案 `drawImage` 满铺）；建 `coatingMask`（异形涂层）。
4. 自建 Pointer Events：容器 `touch-action:none`；`setPointerCapture` + window 兜底 move/up/cancel；多点 `Map<pointerId,last>`；坐标 clamp 到边界；逻辑坐标 ×`s` 进物理空间。
5. rAF 单循环：本帧多点段顺序 `destination-out` stroke（round cap/join，`lineWidth=2r·s`），随后 `canvas.requestRenderAll()` 与网格统计。
6. 统计：默认 8 逻辑像素网格（只读小 canvas 降采样，`alphaCut=16`）；临界 ±3% 触发一次全量仲裁；`ratio>=0.7` 走 `covering→revealing→revealed`，淡出涂层，`revealFired` 保证单次 `onReveal`。
7. 归一化笔画日志（拐点、0..1）；`reset()` 重铺+清日志+复位状态机；`visibilitychange/pageshow` 探针+重放；`ResizeObserver`/DPR 媒体查询→`setDimensions`+重开背板+重放。
8. 图片加载器统一 `crossOrigin`、处理加载失败降级；所有 `getImageData` 包 try/catch 并在污染时降级（停止统计但保留刮擦可视能力 + 上报）。
9. 不使用 `setElement` 更新涂层（`_element` 引用恒定）；如未来给涂层加 clipPath/滤镜/shadow，必须在重绘前 `coating.set('dirty', true)`（依据见 2.2）。

## 附录 B：关键源码证据索引（fabric@7.4.0，安装后位于 node_modules/fabric/）

- 渲染主循环与 rAF 合并：`src/canvas/StaticCanvas.ts:465-469`、`491-506`、`535-569`
- 整画布每帧 `clearRect`：`src/canvas/StaticCanvas.ts:436-438`、`545`
- 背景/overlay 的 save/restore：`src/canvas/StaticCanvas.ts:631-663`
- vpt 与对象 save/restore：`src/canvas/StaticCanvas.ts:550-554`、`626-631`
- 画布 clipPath（destination-in，全帧）：`src/canvas/StaticCanvas.ts:556-600`
- retina：`src/canvas/StaticCanvas.ts:271-273`、`src/env/index.ts:46-47`、
  `src/canvas/DOMManagers/util.ts:9-31`、`src/canvas/StaticCanvasOptions.ts:172`
- 尺寸变更与 hasLostContext/calcOffset：`src/canvas/StaticCanvas.ts:303-323`
- add/remove 触发渲染：`src/canvas/StaticCanvas.ts:223-237`
- 指针坐标 dpr 还原：`src/canvas/SelectableCanvas.ts:1060-1098`
- 上层 canvas 清空与临时笔画：`src/canvas/SelectableCanvas.ts:396-440`
- 命中检测读取专用 willReadFrequently：`src/canvas/SelectableCanvas.ts:1118-1125`
- 双 canvas DOM 与 touch-action：`src/canvas/DOMManagers/CanvasDOMManager.ts:88-105`
- PencilBrush 语义/固化为对象：`src/brushes/PencilBrush.ts:100-124`、`275-302`
- 笔刷默认圆头：`src/brushes/BaseBrush.ts:30-40`
- EraserBrush 不在主包：仅 `src/mixins/eraser_brush.mixin.ts`，`dist/fabric.mjs` 无该导出
- 对象 render save/restore：`src/shapes/Object/Object.ts:649-676`
- dirty/cacheProperties 机制：`src/shapes/Object/Object.ts:611-618`、`683-701`、`911-933`
- 默认 objectCaching：`src/shapes/Object/defaultValues.ts:88`；cacheProperties：`:34-44`
- inverted clipPath 的 destination-out：`src/shapes/Object/Object.ts:801-815`；clip 缓存层：`:844-889`
- FabricImage.setElement 不置 dirty 与尺寸重算：`src/shapes/Image.ts:230-253`、`687-692`
- FabricImage 默认不缓存与 drawImage：`src/shapes/Image.ts:597-632`、`634-662`
- resize 仅 calcOffset：`src/canvas/Canvas.ts:794-797`；多指主触点判定：`:602-617`；
  down 后监听迁到 document：`:684-697`；默认 pointerEvents 关闭：`src/canvas/CanvasOptions.ts:284`
