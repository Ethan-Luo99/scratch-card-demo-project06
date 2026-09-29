# 刮刮卡组件技术设计文档（Vite 8 + Fabric.js v7.4.0）

> 版本事实基准：`package-lock.json` 中 `node_modules/fabric` 锁定 **7.4.0**；本文所有 Fabric 行为结论均以该版本源码为准。
> 证据路径约定：`fabric@7.4.0` 的 npm 包同时发布 `dist/`（构建产物）与 `src/`（TypeScript 源码，见包内 `package.json` 的 files 字段与 `src/` 目录）。下文统一引用安装后的 `node_modules/fabric/src/...` 源码路径并附行号；`dist/fabric.mjs` 行为与之对应。
> 约束提醒：实现轮次禁止改动 v7 内部机制；本文推荐方案只使用公开 API（`FabricImage`、`Pattern`、`requestRenderAll`、`mouse:*` 指针事件、`config.devicePixelRatio`）。

---

## 0. TL;DR（实现者直接照做）

- 奖品层不用 Fabric：奖品图用普通 `<img>`（或 CSS background）放在最底层，Fabric 只负责"涂层"，避免涂层与奖品图在同一上下文互相误伤。
- 涂层 = **一张自管的离屏 canvas**（下称 `coatCanvas`，尺寸取 backstore 像素空间 `cssW*dpr × cssH*dpr`）：初始化时把纯色或自定义图案（如"再来一次"图片，`crossOrigin='anonymous'`）画满。
- Fabric 场景里只有**一个** `FabricImage`（显式 `objectCaching:false`，且其默认缓存条件本就不命中，见 §2.2），其 `_element` 就是 `coatCanvas`。每次手指移动：在 `coatCanvas.getContext('2d')` 上以 `globalCompositeOperation='destination-out'` 画插值补点后的粗线段，然后调用 `fabricCanvas.requestRenderAll()` 让 v7 把新元素整体 `drawImage` 一次。
- 面积统计：对 `coatCanvas` 用**网格降采样 `getImageData`**（步长 8px，物理像素空间），读 alpha 通道算透明比例；rAF 节流（≤每帧 1 次），离开/抬手时再补算一次。
- 达到 70%：状态机去重（`idle → scratching → revealed`），只触发一次 `onComplete`，用一次 CSS opacity 渐变把涂层 `FabricImage` 淡出即"全揭开"。
- DPR：统一在物理像素空间擦除与统计；通过 `config.devicePixelRatio = Math.min(window.devicePixelRatio, 2)` 对超高 DPR 设上限。
- resize：按比例把旧 `coatCanvas` 平滑缩放重绘到新尺寸（涂层与刮痕同步缩放，逻辑宽度不变），再 `setDimensions`；不依赖 canvas 位图自动保留。
- 重置：重建 `coatCanvas`、`coatImage.setElement(newCanvas,{width:cssW,height:cssH})`、`requestRenderAll()`、状态归位。
- 指针：不用 v7 的 drawing mode/Brush；直接监听 Fabric 的 `mouse:down/mouse:move/mouse:up`（文档级 move/up 已由 v7 注册，移出画布笔迹不断，见 §4.2）。

---

## 1. 方案对比矩阵

三条候选路线的本质差异是"刮除发生在哪块像素缓冲、由谁拥有该缓冲"。

| 维度 | A. `destination-out` 离屏画布（推荐） | B. 倒置 clipPath（`inverted: true` 累积笔痕对象） | C. Fabric 笔刷对象（PencilBrush / 自定义 EraserBrush） |
|---|---|---|---|
| **正确性** | 5 | 3 | 2 |
| | 擦除发生在自管离屏 ctx，alpha 即真值，面积可直接像素统计；涂层图案/纯色与擦除天然解耦 | 语义可行：`drawClipPathOnCache` 对 inverted clipPath 走 `destination-out`（`node_modules/fabric/src/shapes/Object/Object.ts:799-817`）；但笔痕是**对象集合**，clipPath 只能挂单个对象，需用 `Group` 包所有笔痕且每帧重建/`dirty` 冒泡，`inverted` 的洞与涂层缓存的边界、`absolutePositioned`、resize 后逐对象坐标重放极易出错 | v7 **已无 EraserBrush**：`dist/fabric.mjs` 中 `eraser` 出现 0 次，包内 `extensions/` 也不含；PencilBrush 画的是**不透明正形笔画**（`src/brushes/PencilBrush.ts`），抬笔时才 `add(Path)`（同文件 `_finalizeAndAddPath`），根本不是"挖洞" |
| **性能** | 4 | 2 | 3 |
| | 每次 move = 离屏 ctx 一条线段 + 全画布一次 `drawImage`；奖品图是 DOM 层不参与 Fabric 重绘；降采样统计固定 O(W·H/step²) | 对象一旦带 clipPath 就**强制独立缓存**：`needsItsOwnCache()` 中 `if (this.clipPath) return true`（`src/shapes/Object/Object.ts:750-766`）；涂层 Group 每一帧在其 `_cacheCanvas` 上重绘涂层+所有笔痕，再合成到主画布，笔痕越多越慢（O(笔痕数) 且无法增量） | 笔画期间画在 upper canvas（`src/canvas/SelectableCanvas.ts:417-433`），增量绘制本身流畅；但抬笔生成 Path 后无法做"减法"，要模拟擦除仍需回到 destination-out，等于半成品 |
| **内存** | 4 | 2 | 4 |
| | 2 个全尺寸缓冲：DOM 奖品 + 1 张 coat 位图；无对象累积 | 涂层缓存层 + 每帧的 clipPath layer（`createClipPathLayer` 每次 `createCanvasElementFor` 新建离屏 canvas，`src/shapes/Object/Object.ts:844-866`）+ N 个 Path 对象，峰值是三条路线里最高的 | 笔画期间 upper canvas + 抬笔后大量 Path 对象（一条刮痕数百个点经 decimate 后仍可观，见 `PencilBrush.ts` `decimatePoints`） |
| **与 Fabric v7 渲染管线兼容性** | 5 | 3 | 2 |
| | 只触达公开管线：元素变化 → `requestRenderAll()` → `renderCanvas` 清屏并 `_renderObjects`（`src/canvas/StaticCanvas.ts:465-470, 535-564`）；`FabricImage.shouldCache()` 在无 clipPath/shadow/滤镜时返回 false（`src/shapes/Image.ts:630-632` + `Object.ts:775-780`），每帧直接 `_render` 当前元素，不经过任何 dirty/缓存判断 | 强行依赖对象缓存失效链：`set()` 只有改 `cacheProperties` 白名单属性才置 `dirty=true`（`src/shapes/Object/Object.ts:611-628`），外部向 Group 增删笔痕对象虽能触发重绘，但 Group/子对象 dirty 冒泡 + `renderCache` 的清空副作用（`isCacheDirty()` 会清空缓存，`Object.ts:911-934`）使时序脆弱 | PencilBrush 与 upper canvas/drawing mode 耦合（`isDrawingMode` 分支提前 return，`src/canvas/Canvas.ts:1052-1054, 1174-1176`）；涂层是 lower canvas 上的对象，upper canvas 的正形笔画无法对其做像素减法；抬笔 `add(Path)` 还会参与选中/命中检测 |

评分：5=完全满足且无额外复杂度，1=需要对抗框架。**推荐路线 A（加权综合最高）。**

### 1.1 为什么 Fabric 官方 demo 的做法在本需求下不够用

官方与"刮/画"相关的现成能力有三块，逐条对照本需求均不成立：

1. **Free drawing（PencilBrush / PatternBrush）**：demo 形态是"在透明 upper canvas 上画正形笔画，抬笔提交为 `fabric.Path`"。
   - 绘制目标是 `canvas.contextTop`（`src/brushes/PencilBrush.ts:177-206` 的 `_render`，`src/brushes/BaseBrush.ts:99-103`），而 lower canvas 每帧 `clearRect` 重绘（`src/canvas/StaticCanvas.ts:436-438, 543`），upper 与 lower 是两个独立缓冲，笔画不会修改涂层的任何像素。
   - `PatternBrush` 只是把 `strokeStyle` 换成 `CanvasPattern`（`src/brushes/PatternBrush.ts` `_setBrushStyles`），解决的是"笔画本身有花纹"，不是"涂层有花纹且被刮穿"。
   - 抬笔 `_finalizeAndAddPath()` 会 `canvas.add(path)`（`src/brushes/PencilBrush.ts:265-278`），产生可选中对象；刮刮卡需要的是涂层像素消失，不是在涂层上堆 Path。
2. **v5/v6 的 Eraser + EraserBrush 在 v7.4.0 已移除**：v7 包内 `dist/fabric.mjs` 检索 `eraser` 为 0 处；仅存的 `src/mixins/eraser_brush.mixin.ts` 是构建期条件编译片段（文件头 `//@ts-nocheck`、`ERASER_START` 标记），**未被 `fabric.ts` 入口与 7.4.0 构建产物包含**。Web 上 v5/v6 的 eraser 教程对 v7 全部失效，照搬会直接 import 失败。
3. **clipPath demo（含 inverted）**：官方示例是静态裁剪单/少量对象。刮刮卡的"洞"是高频增量笔痕，走 B 路线会撞上对象缓存的强制独立层、每帧 clip layer 新建、dirty 白名单三道机制（见上表与 §2），属于用为静态设计的机制去承载高频逐帧更新。

结论：本需求的"像素减法 + 面积真值"只有自管离屏缓冲一条路是与 v7 设计同向的，Fabric 退化为"把离屏涂层位图以一个 Image 对象呈现"的渲染器。

---

## 2. Fabric.js v7 渲染管线分析（难度重点）

> 下列每条结论都附 `node_modules/fabric/src/...` 证据（7.4.0 随包源码）。

### 2.1 `renderAll` 每次做了什么、save/restore 开销在哪

调用链（交互模式）：

1. 我们调用 `requestRenderAll()`：若当前没有挂起帧则 `requestAnimFrame(() => this.renderAndReset())`，天然把同一帧内的多次擦除**合并为一次重绘**（`node_modules/fabric/src/canvas/StaticCanvas.ts:487-494`）。
2. `Canvas.renderAll()`（覆盖 StaticCanvas）：
   - 必要时清 upper canvas；`hasLostContext` 时重画 top layer（`node_modules/fabric/src/canvas/SelectableCanvas.ts:398-410`）；
   - 调 `renderCanvas(this.getContext(), this._objects)`。
3. `StaticCanvas.renderCanvas()`（`node_modules/fabric/src/canvas/StaticCanvas.ts:535-564`）每一帧固定开销：
   - `calcViewportBoundaries()`（矩阵求逆 + 4 点变换）；
   - `clearContext(ctx)` → `ctx.clearRect(0,0,width,height)`，注意清除用的是**逻辑尺寸**但当前 ctx 已带 retina `scale`（见 §2.3），等价于清整个 backstore（`StaticCanvas.ts:436-438`）；
   - `fire('before:render')`；
   - `_renderBackground(ctx)`（本方案不用背景，空跑一次 fill/object 判空）；
   - `ctx.save()` → `ctx.transform(...viewportTransform)` → `_renderObjects` → `ctx.restore()`（`StaticCanvas.ts:550-554`）：**全场景只有一对 save/restore 包住对象遍历**，每个对象 `render()` 内部各自再 save/restore 一对（`node_modules/fabric/src/shapes/Object/Object.ts:649-672`）；
   - 无 clipPath 时跳过 clipPath 分支（本方案 clipPath=undefined，直接省去 `renderCache({forClipping:true})` 与 `drawClipPathOnCanvas`，`StaticCanvas.ts:556-562`）；
   - `_renderOverlay` + `after:render`。
4. 单个 `FabricImage.render()`（`node_modules/fabric/src/shapes/Image.ts:597-601` → `Object.ts:649-672`）：
   - `isNotVisible()` 判定 → `ctx.save()` → `_setupCompositeOperation` → `transform` → `_setOpacity` → `_setShadow`；
   - **关键**：`if (this.shouldCache()) { renderCache + drawCacheOnCanvas } else { this.drawObject(ctx,false,{}); this.dirty=false }`。
   - `FabricImage` 覆盖了 `shouldCache()`，仅当 `needsItsOwnCache()` 为真才缓存（`node_modules/fabric/src/shapes/Image.ts:630-632`）；而基类 `needsItsOwnCache()` 只有两种情况返回 true：`paintFirst==='stroke'` 且同时有 fill/stroke/shadow，或存在 `clipPath`（`node_modules/fabric/src/shapes/Object/Object.ts:750-766`）。本方案涂层图是无 stroke、无 shadow、无 clipPath、无滤镜的 `FabricImage` ⇒ **每帧走 else 分支：直接在主 ctx 上 `_renderFill` 即一次 `drawImage(coatCanvas)`**（`_renderFill` 见 `node_modules/fabric/src/shapes/Image.ts:634-663`，drawImage 目标宽高取对象的逻辑 `this.width/this.height`，因此构造涂层对象时必须显式传入 CSS 逻辑宽高，见 §7.4），随后 `dirty=false`。
   - 结论：每帧与涂层有关的真实成本 ≈ 1 次 clearRect + 1 对场景 save/restore + 1 对对象 save/restore + 1 次全尺寸 drawImage；没有对象缓存层、没有 clip layer 分配。这正是路线 A 的性能基本盘。

### 2.2 "canvas.add 对象"与"外部 canvas 画线后 setElement"两条更新路径与 dirty 机制的配合（失效风险判定）

**路径甲：把笔痕作为对象 `canvas.add(path)`（路线 B/C 的隐含做法）**

- `add()` 会在 `renderOnAddRemove`（默认 true，`node_modules/fabric/src/canvas/StaticCanvasOptions.ts:170`）时 `requestRenderAll()`（`StaticCanvas.ts:220-225`），对象也会 `setCoords()`（`StaticCanvas.ts:239-248`）。
- 但更新内容是否出现，取决于该对象/其父级的缓存判定：
  - `set(k,v)` 仅当 `k` 在类静态 `cacheProperties` 白名单内才置 `dirty=true`（`node_modules/fabric/src/shapes/Object/Object.ts:611-628`，白名单基类定义见同文件 234 行与 `cacheProperties` 常量）。直接改对象上的任意非白名单字段，**不会**使缓存失效。
  - `renderCache()` 只在 `isCacheDirty()` 为真时重画缓存；而 `isCacheDirty()` 有强烈副作用——它检测到需要更新时会先 `clearRect` 清空整个 `_cacheCanvas`（`Object.ts:911-934`，源码注释自己写明 "This check has a big side effect... This is badly designed and needs to be fixed"）。
  - 对象一旦带 `clipPath`，`needsItsOwnCache()` 恒真（`Object.ts:762-765`），且 `_drawClipPath` 每次绘制都经 `createClipPathLayer` **新建一张离屏 canvas**（`Object.ts:844-866, 872-890`）。倒置 clipPath 用 `destination-out` 合成（`Object.ts:807-811`）。
- 失效风险点：若有任何代码让涂层对象进入缓存（例如后来加了 shadow、clipPath、Group 包裹），而笔痕变化没有正确沿"子 dirty → 父 dirty"冒泡（冒泡规则在 `Object.ts:619-628`，`parent._set('dirty', true)` 仅在子 dirty 或 stateProperties 变更时发生），就会出现"数据变了、画面不更新，直到别的属性触发 dirty"的经典缓存失效 bug。

**路径乙：外部 canvas（`coatCanvas`）上 `destination-out` 画线，再让 Fabric 显示它（本方案）**

- `FabricImage.setElement(el)` 只做三件事：换 `_element/_originalElement`、`_setWidthHeight()`、必要时跑滤镜（`node_modules/fabric/src/shapes/Image.ts:238-256`）。**它不置 dirty、不请求渲染**（同段源码无 `set('dirty')`/`requestRenderAll`；其 JSDoc 也明确 "you might need to call canvas.renderAll"）。
- 但因为涂层 `FabricImage.shouldCache()===false`（§2.1），根本不存在缓存失效问题：每帧 `renderCanvas` 都是无条件 `clearRect` 后重画所有对象，`drawObject → _render → _renderFill` 直接把当前 `coatCanvas` 像素 `drawImage` 上屏。所以更新序列为：
  1. 在 `coatCanvas` ctx 上画擦除线段（像素已变）；
  2. `fabricCanvas.requestRenderAll()`（rAF 合并）；
  3. 下一帧 clearRect + drawImage，画面必然反映新像素。
- 因此在**本方案的对象配置（无 clipPath/shadow/滤镜、不进 Group、不设 objectCaching 强制）下，路径乙没有失效风险**。必须写成实现约束：涂层 `FabricImage` 永远不要加 `clipPath`、`shadow`、滤镜，也不要被 `Group` 包裹；初始化时显式 `coatImage.set({ objectCaching: false })` 做双保险（即使将来误加属性，也走直绘路径）。
- 补充：`setElement` 仅在**重置**（整张涂层换成新 canvas）时调用一次；逐帧刮除不需要也不应当反复 setElement（它会清纹理缓存 key 并可能触发 resizeFilter，`Image.ts:238-245`）。逐帧只改同一 `coatCanvas` 像素 + `requestRenderAll`。

### 2.3 enableRetinaScaling 开启时的尺寸/缩放关系；面积统计读哪个像素空间

- 默认 `enableRetinaScaling: true`（`node_modules/fabric/src/canvas/StaticCanvasOptions.ts:172`）。`getRetinaScaling() = enableRetinaScaling ? getDevicePixelRatio() : 1`（`node_modules/fabric/src/canvas/StaticCanvas.ts:271-273`），`getDevicePixelRatio()` 取 `Math.max(config.devicePixelRatio ?? window.devicePixelRatio, 1)`（`node_modules/fabric/src/env/index.ts:46-47`，全局可覆盖值定义在 `node_modules/fabric/src/config.ts:29-30`）。
- 建画布/改尺寸时（`node_modules/fabric/src/canvas/DOMManagers/util.ts:10-19` 的 `setCanvasDimensions`）：
  - `el.width = width; el.height = height;` 先赋逻辑值；
  - 当 retinaScaling>1：**再**把元素的 `width/height` attribute 覆盖为 `width*r × height*r`（backstore 物理像素），CSS 尺寸另行设为 `width × height` px（`util.ts:24-30` 的 `setCSSDimensions`，由 `StaticCanvas._setDimensionsImpl` 分别调用，`StaticCanvas.ts:303-323`）；
  - 随后执行一次 `ctx.scale(r, r)`（`util.ts:18`）。即 lower 与 upper 两个 ctx 的**基础变换都自带 dpr 倍**，Fabric 所有逻辑坐标（width/height、对象坐标、指针场景坐标）都是 CSS 像素。
  - upper canvas 同样按此设置（`node_modules/fabric/src/canvas/DOMManagers/CanvasDOMManager.ts:97-100`）。
- 指针坐标换算也证实逻辑空间是 CSS px：`_getPointerImpl` 用 `getBoundingClientRect()` 把 `clientX/Y` 转到画布原点，除以 retinaScaling，再按 backstore/CSS 比修正（`node_modules/fabric/src/canvas/SelectableCanvas.ts:1060-1097`）。Fabric 事件给我们的 `scenePoint/viewportPoint` 都是 CSS px 坐标。
- **面积统计必须读物理像素空间**，原因：
  1. 刮除的真相在 `coatCanvas` 的 alpha 通道里，`coatCanvas` 由我们自建，其 backstore 尺寸就是 `cssW*dpr × cssH*dpr`；`getImageData` 返回的也是该 backstore 的物理像素，不存在隐藏缩放；
  2. 若误读 Fabric 的 lower canvas，会混入背景/对象合成结果且其 ctx 带 scale（`getImageData` 不受 transform 影响但尺寸是物理的，坐标极易错位）；
  3. 结论：擦除坐标由 CSS px 乘以 `dpr` 映射到 `coatCanvas` 物理空间绘制；统计直接对 `coatCanvas.ctx.getImageData(0,0,coatCanvas.width,coatCanvas.height)` 的 alpha 做网格采样。两个空间的换算因子只有一个：`dpr`（不乘 viewportTransform——本方案 viewportTransform 恒为单位阵，不启用缩放/平移）。
- DPR 上限策略：通过 `import { config } from 'fabric'; config.devicePixelRatio = Math.min(window.devicePixelRatio, 2)` 在 `new Canvas` 之前设置，使 Fabric backstore 与自管 coat 都按封顶 dpr 走（4xx/5xx 的安卓机 dpr 3~4 会让全幅 drawImage 与 getImageData 成本翻 9~16 倍，封顶 2 是刮刮卡类业务的通用取舍）。
- 匹配性检查：`config.devicePixelRatio` 必须在 Fabric 构造画布**之前**赋值；`coatCanvas` 的 `dpr` 与 Fabric 取同一个值 `fabricCanvas.getRetinaScaling()`（公开方法，`StaticCanvas.ts:271-273`），不要各自读 `window.devicePixelRatio`。

### 2.4 `destination-out` 在哪块上下文生效；直接操作 Fabric 顶层 canvas 元素会怎样

- `destination-out` 的效果（既有像素 α 与新画图形 α 相减，颜色无关）只作用于**调用时所在的那个 context 的当前位图**。本方案它只出现在 `coatCanvas.getContext('2d')`：涂层像素被挖穿，挖穿处在 `FabricImage` 下次 drawImage 时为透明，下面一层 DOM 奖品图自然透出。
- 绝不能在以下两个 Fabric 拥有的 ctx 上做擦除：
  1. **lower ctx**（`fabricCanvas.getContext()` / `lowerCanvasEl`）：它每帧 `renderAll` 开头被 `clearRect` 整体清空（`node_modules/fabric/src/canvas/StaticCanvas.ts:543`），任何直接画上去的内容最多存活一帧；而且它是 Fabric 遍历对象、应用 viewportTransform 的同一上下文，手改其状态（composite operation、transform、path）会污染后续对象绘制。
  2. **upper ctx**（`contextTop` / `upperCanvasEl`）：它是交互覆盖层，每帧 `renderTop()` 开头 `clearContext`（`node_modules/fabric/src/canvas/SelectableCanvas.ts:436-440`），drawing mode 下还会被笔刷反复清空重画（`SelectableCanvas.ts:417-433`）；在其上 destination-out 只会擦掉 upper 自己的覆盖像素（选择框/笔画），碰不到 lower 的涂层。
- 直接改 Fabric 顶层 canvas 元素尺寸（`lowerCanvasEl.width=...`）还会触发两件事：上下文位图被浏览器清空、基础 transform 重置，而 Fabric 内部仍认为尺寸/变换由 `_setDimensionsImpl → setCanvasDimensions` 管理（`StaticCanvas.ts:303-318` 把 `hasLostContext=true` 只在其**自己的**尺寸流程里设置）；绕过该流程手改 attribute 会让"清空事实"与 `hasLostContext` 状态不一致。正确的尺寸入口只有 `fabricCanvas.setDimensions()`（`StaticCanvas.ts:334-352`，内部走 `_setDimensionsImpl` 并 `requestRenderAll`）。
- Fabric 自身用到 destination-out 的位置只有两处，都是**对象缓存 canvas**，不是主画布：倒置 clipPath 合成（`Object.ts:807-811`）与构建期 eraser mixin（7.4.0 未编入，见 §1.1）。这也反向说明：想在 v7 主画布上持续做像素减法，框架没有给公开挂载点，自管离屏 canvas 是唯一与管线不冲突的位置。

---

## 3. 面积统计算法

### 3.1 三种统计方案对比与选型

统计目标：`scratchedRatio = coatCanvas 中透明（α≈0）像素数 / 总像素数`。α 用 `a < 16`（约 6%）判透明，抗锯齿边缘像素按非透明计入，避免笔尖 1px 边缘造成抖动。

| 方案 | 做法 | 单次复杂度（物理像素 N=W·H） | 精度 | 评价 |
|---|---|---|---|---|
| 全量 `getImageData` | 每帧/每抬手读整张 coat，遍历全部 alpha | O(N) 时间 + O(N) 内存拷贝；CSS 375×500@dpr2 = 75 万个 alpha | 真值，误差 0 | 移动端高频 move 下每帧 75 万元素循环 + 一次全缓冲 readback，低端机可能掉帧；readback 本身还可能触发 GPU→CPU 同步 |
| **网格降采样（选定）** | 步长 `STEP=8` 物理像素，仅读 stride 切出的区域（见下），遍历时再按 stride 跨步 | O(N/64)；同上例约 1.17 万次比较 | 统计误差随刮痕宽度收敛；笔刷直径 ≥ 24 物理像素时误差远小于 1% | 成本恒定且与刮开程度无关；可在 rAF 内联完成无感知 |
| 增量计数 | 每次擦除只统计"本轮线段覆盖的包围盒"内像素的 alpha 变化，维护透明像素总数 | 与线段面积相关，均摊低；但要自己处理重叠刮除（同一像素被二次擦除不能重复计数），必须读包围盒旧数据做差 | 可达真值 | 实现复杂：包围盒并集、抗锯齿半透明像素的 α 递减都要正确维护；resize 后全量重算；收益相对网格方案不明显，属于过早优化 |

**选定：网格降采样**，并加两个工程细节：

1. 读取范围也降采样：不必把整张 `ImageData` 拷贝回来。按 `STEP` 网格读小 patch 在多数浏览器上调用次数过多，反而更慢；实测通用最优是 `getImageData(0,0,W,H)` 拿一次（浏览器对同尺寸 canvas 的连续 readback 有优化），然后**仅遍历 `for(y=0;y<H;y+=STEP) for(x=0;x<W;x+=STEP)`**，下标 `(y*W+x)*4+3`。即"全量拷贝 + 1/64 遍历"。若后续 profiling 证明 readback 拷贝是瓶颈，再降级为分块（如每块 64×64）读取并缓存块结果，只在块与脏包围盒相交时重算（增量方案的简化版），接口不变。
2. 统计时机：move 事件里只置 `needsMeasure=true`；统一在一个 rAF 循环里"先 requestRenderAll 渲染、本帧末尾 measure"或与渲染同一个 rAF 串行，保证一帧最多统计一次；`mouse:up` 后立即补一次统计（防止最后一笔刚好越线而 rAF 未跑）。

采样数下限保护：极端尺寸下保证网格点数 ≥ 4096（`STEP = Math.max(4, Math.min(12, Math.round(Math.sqrt(N/4096))))`，再夹到 12），避免小卡上统计过粗。

### 3.2 快速滑动的插值补点（防虚线）

问题根因：触摸 move 事件在快速滑动时间隔可达 16~50ms，两点在 CSS 空间能相距 30~80px；若"每点画一个圆"，圆间距大于直径就断成虚线。正确做法是**始终在上一点→当前点之间画一条连续粗线**（lineCap/lineJoin = round 自带圆头），再对点间距超过阈值的区段做线性补点（补点同时服务于面积统计的响应即时性与未来换橡皮形状）。

伪代码（坐标统一先转物理像素空间）：

```
// dpr = fabricCanvas.getRetinaScaling()；coatCtx 为 coatCanvas 的 2d ctx，
// coatCanvas 尺寸 = cssW*dpr × cssH*dpr，ctx 不带任何 scale（setTransform(1,0,0,1,0,0) 后使用）
const BRUSH_CSS = 28;                 // CSS px，实现期可调（建议 24~36）
const brushR = BRUSH_CSS * dpr / 2;   // 物理半径
const MAX_SEG = brushR;               // 相邻绘制点不超过一个半径，保证重叠覆盖
let last = null;                      // 上一物理点
let drawing = false;

function toPhysical(scenePoint) {     // Fabric 事件给的是 CSS px 场景坐标
  return { x: scenePoint.x * dpr, y: scenePoint.y * dpr };
}

function strokeSegment(a, b) {
  coatCtx.save();
  coatCtx.setTransform(1, 0, 0, 1, 0, 0);
  coatCtx.globalCompositeOperation = 'destination-out';
  coatCtx.strokeStyle = '#000';       // 颜色任意，destination-out 只取 alpha
  coatCtx.lineWidth = brushR * 2;
  coatCtx.lineCap = 'round';
  coatCtx.lineJoin = 'round';
  coatCtx.beginPath();
  coatCtx.moveTo(a.x, a.y);
  coatCtx.lineTo(b.x, b.y);
  coatCtx.stroke();
  coatCtx.restore();
}

onDown(p) {
  drawing = true;
  last = toPhysical(p);
  strokeSegment(last, { x: last.x + 0.1, y: last.y }); // 点一下也出一个圆洞
  scheduleFrame();
}

onMove(p) {
  if (!drawing) return;
  const cur = toPhysical(p);
  const dist = Math.hypot(cur.x - last.x, cur.y - last.y);
  const n = Math.max(1, Math.ceil(dist / MAX_SEG));
  for (let i = 1; i <= n; i++) {     // 线性插值补点，逐段画
    const q = {
      x: last.x + (cur.x - last.x) * i / n,
      y: last.y + (cur.y - last.y) * i / n,
    };
    strokeSegment(i === 1 ? last : prevQ, q);
    prevQ = q;
  }
  last = cur;
  scheduleFrame();                   // 每 move 至多挂一帧 requestRenderAll + measure
}

onUp() { drawing = false; measureNow(); }
```

说明：

- round lineCap 使每段两端是半圆，等宽相连段的并集与连续曲线在覆盖区域上等价，肉眼无断点；不依赖 `quadraticCurveTo`（刮卡不需要平滑曲线，且直线段 + 圆头在高速段更易保证不漏像素）。
- 插值密度按"≤一个半径"取，最坏补点数 = 距离/半径（CSS 28px 笔宽、80px 间距 ≈ 补 6 段），单帧总量很小。
- `coatCtx` 每次 `save/restore` 包裹并显式 `setTransform`，确保 composite operation 与 transform 不泄漏（也可初始化时设一次、只在 resize 后重设，但 save/restore 更抗误改）。
- 不在事件处理里同步 `getImageData`（可能引起 GPU stall），统一进 rAF。

### 3.3 阈值跨过 70% 时只触发一次回调

用显式状态机，回调触发与"自动揭开"都只在状态迁移时执行，不依赖比例数值的单调性判断：

```
state = 'idle'            // idle：未开始；scratching：刮擦中；revealed：已揭底/已结算
onProgress(ratio) {       // 每帧 measure 后调用
  if (state === 'revealed') return;
  if (ratio > 0) state = 'scratching';
  emit('progress', ratio);
  if (ratio >= 0.70 && state !== 'revealed') {
    state = 'revealed';
    revealAll();                        // 一次性：涂层淡出 + 停掉输入
    emit('complete', { ratio });        // 回调只可能在这一行触发一次
  }
}
reset() { state = 'idle'; /* 重建涂层 */ }
```

要点：

- `revealed` 为终态（reset 前不再 measure/不再触发）；即使后续 ratio 抖动（理论上单调不减，但 resize 重采样可能有 ±1% 波动）也不会重复回调。
- 比较用 `>= 0.70`；网格误差远小于与阈值的典型余量，如需工程保险可用 `0.695` 提前判定，但文档建议保持 0.70 真值阈值。
- `revealAll()`：对涂层 `FabricImage` 用 CSS/对象 opacity 做一次 200~300ms 淡出（或直接 `fabricCanvas.remove(coatImage)` 后令 coatCanvas 全透明），期间把输入处理短路（`if (state==='revealed') return`）。推荐淡出而非瞬间移除，避免"最后一笔后画面跳变"。
- 事件形式对外暴露：`onProgress(ratio)`（节流到帧）、`onComplete()`、`onReset()`；组件内部用 v7 的 `on('mouse:*')` 或裸 pointer 事件均可，回调由状态机统一发。

---

## 4. 边界清单

### 4.1 多点触控

- v7 交互 Canvas 内部有"主触摸"概念：`_onTouchStart` 在 `mainTouchId===undefined` 时记录第一根手指 id（`node_modules/fabric/src/canvas/Canvas.ts:624-633`），`_isMainEvent()` 对 TouchEvent 只放行 `changedTouches[0].identifier === mainTouchId` 的事件（`Canvas.ts:602-616`）。
- 设计决策：刮刮卡**只接受单指刮擦**。直接依赖 v7 过滤（监听 `mouse:down/move/up`，非主触摸不会派发处理逻辑），自己的处理不再做多指状态。第二根手指落下/移动被忽略；主指抬起（`touchend` 且 `touches.length===0` 时 `_isMainEvent` 恒真，`Canvas.ts:609-610`）正常结束一笔。
- 不启用 v7 的 `enablePointerEvents`（默认 false，`node_modules/fabric/src/canvas/CanvasOptions.ts:284`）与手势 mixin；上层容器 CSS 加 `touch-action: none`（v7 自己也给 upper canvas 设了 `touch-action:none`，`node_modules/fabric/src/canvas/DOMManagers/CanvasDOMManager.ts:90-99`，`allowTouchScrolling` 默认 false，`node_modules/fabric/src/canvas/StaticCanvasOptions.ts:182`），防止刮擦时页面滚动/下拉刷新。
- 若产品要求双指同时刮，最小扩展是自管 `Map<pointerId, lastPoint>`，但需自行在 document 上监听 PointerEvent（v7 只回调主指），本期不做。

### 4.2 指针移出画布再移回的笔迹连续性

- v7 在 down 的瞬间就把 move/up 监听从画布元素切换/注册到 **document**（`node_modules/fabric/src/canvas/Canvas.ts:675-693`：`removeListener(upper, 'mousemove')` + `addListener(doc, 'mouseup'/'mousemove')`；触摸路径同理注册到 doc，`Canvas.ts:624-666`），up 时再移除（`Canvas.ts:744-765`）。
- 因此一笔之内指针滑出画布：document 上仍持续收到 move（坐标可能超出 `[0,cssW]×[0,cssH]`），再滑回时 `last → cur` 自然连线，笔迹不断。
- 我们的处理：
  1. 不使用 `PencilBrush.limitedToCanvasSize`（其越界直接 `return` 会造成断笔，见 `node_modules/fabric/src/brushes/PencilBrush.ts:80-83`）——本方案自管绘制，本来就没有该限制；
  2. 对越界坐标只做"夹取用于绘制、不用于状态"：物理点 `q` 夹到 `[-margin, W+margin]`（margin=笔半径），这样出界段沿画布边缘持续擦除、回滑入时无缺口；不要简单丢弃越界点（丢弃会让回滑后的连线跨过未擦区域，视觉上像"突然刮开一条"）。
  3. 坐标换算仍走 Fabric 事件坐标（其内部每次都 `getBoundingClientRect` 重算，`SelectableCanvas.ts:1060-1097`，跨浏览器滚动/定位变化不会算偏）。

### 4.3 iOS Safari 的 getImageData 行为

- **安全/跨域**：若涂层图案是跨域 `<img>`（如 CDN 且未返回 `Access-Control-Allow-Origin`），把它画入 canvas 会让 canvas 变为 origin-tainted，随后 `getImageData` 直接抛 `SecurityError`。措施：图案图片一律 `img.crossOrigin='anonymous'` 加载，CDN 配置 CORS；图案加载失败时降级为纯色银涂层（不能因为一张图挂掉整个组件）。同域/打包进 `assets` 的图无此问题。
- **旧版 WebKit 怪癖（需按 §5 实验复核）**：iOS 部分版本对 2D canvas readback 在 GPU 进程繁忙时返回**全 0 的 ImageData**（曾在多处 canvas 类业务中出现），表现为"比例恒为 0"或"恒为 100%"。防御：measure 结果做健全性校验——若整张 ImageData 所有 alpha 全相等且涂层确认非空，本次结果丢弃沿用上一次（并打点），而不是误触发 complete。
- 现代 iOS（15+）2D canvas 已不走 WebGL，不存在 webglcontextlost；但仍有**后台标签页/系统回收导致 2D 上下文位图丢失**的情况，见 §4.4。
- 性能：iOS Safari 对超大 canvas 的 `getImageData` 有显著的 GPU→CPU 同步成本，这是 dpr 封顶 2 + 网格降采样 + rAF 节流的三重原因。
- 内存：iOS 对单页 canvas 总像素有上限（历史上约 16M~？像素，超限 canvas 创建失败为空白）。`coatCanvas` + Fabric lower + upper 三张同尺寸缓冲在 dpr2 下 375×500 约 3×2.25MB 像素内存，安全；但不要为了统计再创建同尺寸临时 canvas（这也是 §3 不采用全量像素额外缓冲的理由）。

### 4.4 页面切走（切后台/锁屏/滚动出视口）后重绘丢失

- canvas 位图在 iOS 后台回收、Android 低内存、或浏览器长时间挂起后可能被清空。**Fabric 侧有兜底**：其 `_setDimensionsImpl` 会把 `hasLostContext=true`（`node_modules/fabric/src/canvas/StaticCanvas.ts:312-316`），`renderAll` 看到该标记会重画 top layer（`SelectableCanvas.ts:405-408`），而 lower canvas 本来就是每帧由对象完整重建（`renderCanvas` 先 clearRect 再重画对象，`StaticCanvas.ts:543-551`）——只要 `coatCanvas` 像素还在，Fabric 下一帧 `requestRenderAll` 就能恢复显示。
- **风险在自管的 `coatCanvas`**：它是 Fabric 不知道的外部 canvas，被系统清空后不会自动恢复，表现为"奖品图全露但状态机仍在 scratching"或"涂层整块消失"。
- 措施：
  1. 监听 `document.visibilitychange`（hidden→visible）与 `window` 的 `pageshow`：回到前台时主动做一次 `coatCtx.getImageData` 健全性探测（或维护一个"脏标记版本号"无法感知系统清空，故用像素探测：涂层非全空时若读到全 0/全透明即判定丢失），丢失则按 §4.5 的同一套"从持久状态重建"流程恢复；
  2. 刮擦进度不需要逐笔持久化，重建策略为：若已 `revealed` 则直接保持揭开；否则按最后一次 measure 的 ratio 无法还原形状——**决策：不持久化刮痕形状**，后台丢失后重新铺一张完整涂层（用户重刮），并 fire 一个 `coat:restored` 事件让业务层可提示。理由：持久化整张 coat 位图（toDataURL）在每次越阈值时存一次代价可接受，列为可选增强（见 §5）。
  3. 正常的 Fabric 对象丢失场景由 `renderAll` 自愈，我们只需在 visibilitychange 后补一次 `requestRenderAll()`。

### 4.5 resize 后的坐标系与状态重映射

- 触发：`ResizeObserver` 观察容器（rAF 去抖），或 window resize。Fabric 的 window resize 默认只 `calcOffset()` 不重设尺寸（`node_modules/fabric/src/canvas/Canvas.ts:794-797`），尺寸必须我们自己调。
- v7 尺寸变更必须走 `fabricCanvas.setDimensions({width,height})`：内部 `_setDimensionsImpl` 同步重设 lower/upper 的 backstore（重设 attribute 必然清空位图并重置 ctx scale）、CSS 尺寸、offset，并置 `hasLostContext=true`（`StaticCanvas.ts:303-323`；DOM 层 `CanvasDOMManager.setDimensions` 同时改 lower 与 upper，`CanvasDOMManager.ts:97-100`）。
- `coatCanvas` 重映射步骤（保持刮痕不丢）：
  1. 记旧物理尺寸 `W0×H0`，新建 `next = W1×H1` 空 canvas（dpr 可能也变了，如窗口跨屏拖动；dpr 以新的 `getRetinaScaling()` 为准）；
  2. `next.ctx.setTransform(1,0,0,1,0,0)` 后先把新涂层底图（纯色/图案）铺满；
  3. `next.ctx.globalCompositeOperation='destination-out'`，把**旧 coatCanvas 作为图像源**按比例 `drawImage(old, 0,0,W0,H0, 0,0,W1,H1)` 整体缩放画出——旧的透明洞等比映射到新缓冲（平滑缩放由 `imageSmoothingEnabled` 控制，开；半透明边缘会被轻微柔化，对 70% 判定影响 <1%）；
  4. 用新 canvas 替换：`coatImage.setElement(next, { width: cssW1, height: cssH1 })`（`setElement` 的第二参经 `_setWidthHeight` 写入对象逻辑宽高，`node_modules/fabric/src/shapes/Image.ts:238-256, 687-692`；必须显式传 CSS 逻辑值，否则对象宽高退化为 next 的物理像素尺寸、在 dpr>1 时被放大），再 `fabricCanvas.setDimensions({width:cssW1,height:cssH1})`，随后 `requestRenderAll()`；
  5. resize 后立即做一次 measure 校准 ratio（重采样可能有极小偏差），状态机保持原 state 不变（`scratching` 不会因一次 measure 误判，阈值去重见 §3.3）。
- 坐标：所有新事件坐标由 Fabric 按新 `getBoundingClientRect` 与新 dpr 给出（`SelectableCanvas.ts:1060-1097`），我们每次乘的是"当前" dpr，无需自己存缩放矩阵；view 不启用 zoom/pan，viewportTransform 恒单位阵。
- CSS 布局约束：Fabric 容器由 v7 创建（`CanvasDOMManager` 用绝对定位的 upper 覆盖 lower，`CanvasDOMManager.ts:30-49`）；我们控制容器 CSS 宽高即可，容器内两层 canvas 的宽高由 v7 管理，不要手改 style。

---

## 5. 风险清单（按 发现概率 × 影响 排序）

| # | 风险 | 概率 | 影响 | P×I | 最小证实/证伪实验 |
|---|---|---|---|---|---|
| R1 | 跨域涂层图污染 canvas，`getImageData` 抛 `SecurityError`，统计与揭开全失效 | 中 | 高 | 高 | 用一张不带 CORS 头的跨域图初始化涂层，在真机 Safari/Chrome 各刮一次：预期抛错；加 `crossOrigin='anonymous'`+CORS 头后恢复。实验同时验证降级纯色分支 |
| R2 | iOS Safari/低端机每帧 readback 卡顿（快速刮擦掉帧、笔迹滞后） | 中 | 高 | 高 | 在 iPhone（SE 级与主流各一台）用 dpr 原始值 vs 封顶 2、全量 vs 步长 8 四种组合，刮 10 秒用 Performance 面板/`performance.now()` 包住 measure，比较帧时；目标 P95 一帧 < 16.7ms |
| R3 | 高速滑动仍出现断洞（事件点稀疏 + 补点阈值过大） | 中 | 中 | 中 | 用程序化 `PointerEvent` 以 80px/16ms 步进对角线扫过，导出 coatCanvas 放大检查洞的连通性；沿路径每 2px 采样 alpha 应全透明。调 `MAX_SEG=brushR` 即应通过 |
| R4 | resize/跨屏（dpr 变化）后刮痕错位或涂层丢失 | 中 | 中 | 中 | 桌面拖拽窗口在 dpr1 外屏与 dpr2 主屏间移动、手机横竖屏切换，刮开约 40% 后切换：洞应等比保留、ratio 偏差 ≤2%、state 不错乱 |
| R5 | iOS 后台回收后 coat 位图清空，回前台画面与状态不一致 | 低-中 | 中 | 中 | iOS Safari 刮到一半切后台 >30s（可开多个大内存页面加速回收），回前台观察；验证 `visibilitychange` 探测与重铺涂层/事件路径 |
| R6 | 阈值附近因网格误差/resize 重采样导致 complete 提前或永不触发 | 低-中 | 中 | 中 | 构造刮到 68%/70%/72% 的固定图案（用脚本画洞后 measure），各 100 次统计看分布与离散度；确认状态机只触发一次（断言 `onComplete` 调用计数恒为 1） |
| R7 | v7 版本被误升级后结论漂移（setElement 行为、对象缓存条件、入口导出变化） | 低 | 高 | 中 | CI 加一行断言：`require('fabric/package.json').version` 主版本为 7；升级时重跑本文件 §2 的源码行号 spot check（grep `shouldCache`、`setCanvasDimensions`、`renderCanvas`） |
| R8 | 多指/手掌误触导致主指 id 切换后笔迹中断或报错 | 中 | 低 | 中 | 双指、三指乱滑 + 一指抬起：仅主指出洞，无异常、无卡死；第二指期间 ratio 不应跳变 |
| R9 | 指针移出浏览器窗口（不是 document）时收不到 up，`drawing` 卡 true | 低 | 中 | 低-中 | down 后直接把鼠标甩出窗口松开，再移回点击：验证监听 window `blur`/pointer `pointercancel` 强制 `onUp` 收尾（实现中补这两个监听即可，成本极低） |
| R10 | 重置与刮擦并发（重置发生在挂起的 rAF 回调里）造成写已废弃 canvas | 低 | 中 | 低-中 | 快速连点"重置"按钮 20 次并同时触摸：断言无异常、每轮涂层完整；实现上 rAF 回调捕获当代 token，token 不匹配直接返回 |
| R11 | 涂层图案尺寸/宽高比与画布不一致导致拉伸或留缝 | 中 | 低 | 低-中 | 用 1:1、3:1、1:3 三张图案初始化非等比画布：明确填充策略（选定 `cover` 裁切铺满，不允许 repeat 接缝，也可由配置项切 `fill` 拉伸） |
| R12 | 上层 Fabric 后续被业务方加了 clipPath/shadow 导致涂层 Image 意外进入缓存路径，像素更新失效（§2.2 的约束被破坏） | 低 | 中 | 低-中 | 代码评审 + 一个单测：断言 `coatImage.shouldCache()` 在构造后为 false；文档中把"涂层对象禁加 clipPath/shadow/滤镜/Group"列为硬性约束 |

---

## 6. 验收用例表（人工）

前置：构建奖品底图（与刮开区同尺寸）与一张写有"再来一次"的涂层图案图；组件按 §7 契约以默认参数挂载。

| # | 用例 | 步骤 | 预期结果 |
|---|---|---|---|
| AC1 | 初始渲染 | 页面加载完成，不做任何操作 | 涂层 100% 覆盖奖品图，图案（"再来一次"）完整、无拉伸无接缝；`progress=0`，未触发 complete |
| AC2 | **DPR=1** | 在外接显示器或 DevTools 模拟 dpr=1、CSS 375×500 挂载后刮擦 | Fabric lower/upper backstore = 375×500（DevTools 检查 `width/height` 属性），coatCanvas 同尺寸；刮洞位置与手指位置重合，无 2x 偏移 |
| AC3 | **DPR=2（高 DPR）** | Retina/模拟 dpr=2、同 CSS 尺寸挂载并刮擦 | backstore = 750×1000，CSS 尺寸仍 375×500；涂层图案边缘清晰不虚化；刮洞跟手；ratio 数值与 dpr=1 同刮法差异 ≤2% |
| AC4 | 慢速刮除 | 以正常速度刮开约 30% 面积 | 笔画为均匀等宽圆头带，无虚线；`onProgress` 单调不减，数值与目测刮开比例一致 |
| AC5 | **快速滑动** | 以最快速度对角线来回猛划 3 秒（鼠标与真机手指各一次） | 笔迹全程连续无任何断洞/虚线点；过程不卡顿（目测无拖影滞后）；无控制台报错 |
| AC6 | **阈值触发** | 持续刮至刚过 70% | 越过 70% 的当帧触发一次 `onComplete`；涂层播放一次短淡出后奖品全显；之后继续刮或任何操作都**不再**触发 complete（断言计数=1） |
| AC7 | 阈值前 | 只刮到约 50% 后停手 | 不触发 complete；放置 10 秒、切后台再回来，画面保持刮开 50% 的状态（或按 §4.4 策略重铺并发出 `coat:restored`，二者必居其一且符合文档） |
| AC8 | **重置再刮** | 刮到任意比例（含已 complete）后调用 `reset()` | 涂层立即恢复 100% 完整、可重新刮；state 回 idle；新一轮仍可在 70% 触发一次 complete；连续 reset 5 次无内存报错 |
| AC9 | **resize 状态保留** | 刮开约 40% 后：桌面拖拽改变容器宽度；手机旋转屏幕 | 画布与涂层自适应新尺寸，已有刮痕按比例保留、不消失不错位；resize 后继续刮，ratio 在原值基础上继续增长并能正常到 70% 触发 |
| AC10 | 越界回滑 | 一笔从画布内快速滑出画布外（移出浏览器可视区边缘）再滑回，最后在画布外松开 | 出界期间边缘被连续擦除，回到画布后笔迹与之前连通无缺口；松手后再次按下可正常刮（drawing 状态复位） |
| AC11 | 多点触控（真机） | 单指刮擦中第二、三根手指同时落下乱滑后抬起 | 仅第一根手指产生刮除，第二指不产生洞、不导致跳动；主指抬起后再按可开新一笔；页面不滚动（touch-action 生效） |
| AC12 | 自定义涂层 | 分别传入：纯色银（不传图）、同域"再来一次"图、跨域且 CORS 正确的图、跨域无 CORS 的图 | 前三种正常显示与统计；第四种不崩溃，自动降级纯色涂层且有可观测的降级事件/日志，`getImageData` 不抛 SecurityError |
| AC13 | 纯点击 | 不移动，手指/鼠标轻点一下 | 出现一个直径≈笔宽的圆形洞（不是 0 尺寸的点），ratio 有微小增长 |
| AC14 | 浏览器兼容 | Chrome、Safari（含 iPhone）、Android WebView 各跑 AC5/AC6/AC8 | 行为一致；iOS 上无掉帧明显劣化、无安全异常 |

通过标准：AC1–AC10 为 P0 全部必过；AC11–AC14 为 P1，允许记录问题但 R1/R2 相关项不得带已知高风险上线。

---

## 7. 实现契约（实现者无需再做选型决策）

### 7.1 分层结构

```
<div id="scratch-card" style="position:relative; width:..; height:..">
  <img class="prize" src="奖品图" style="position:absolute;inset:0;width:100%;height:100%">
  <canvas id="fabric-canvas">   <!-- v7 会在外层包 .canvas-container，内含 lower+upper -->
</div>
```

- 奖品层：DOM `<img>`，z-index 最低；Fabric 画布背景透明（默认），涂层 Image 透明处直接透出奖品。
- Fabric 场景对象数恒为 1（涂层 `FabricImage`），不使用 backgroundImage/overlay（避免 §2.1 中额外分支与缓存）。

### 7.2 组件 API（定案）

```
createScratchCard({
  el,                       // 挂载的 <canvas>
  width, height,            // CSS px
  prizeImage,               // string URL（奖品图，DOM 层）
  coat: {
    type: 'color'|'image',  // 默认 image；图案加载失败降级 color
    color  = '#c0c0c0',     // type=color 或降级时
    imageUrl,               // type=image，跨域必须可 CORS
    fit = 'cover',          // cover（默认）| fill | contain
  },
  brushSize = 28,           // CSS px
  threshold = 0.70,
  dprCap = 2,
  onProgress(ratio), onComplete(), onReset(), onCoatRestored(),
}) -> { reset(), destroy(), getRatio() }
```

- `destroy()`：`fabricCanvas.dispose()`（v7 公开销毁入口，会移除 DOM 与监听）+ 移除自有监听 + 释放 coat canvas 引用。
- 事件绑定：`fabricCanvas.on('mouse:down'|'mouse:move'|'mouse:up', …)`（v7 对触摸同样派发这组事件，主触摸过滤由 v7 完成，证据 §4.1）；另在 window 上注册 `pointercancel` 与 `blur` 强制收尾一笔；`document.visibilitychange` 做丢失探测；`ResizeObserver` 做尺寸更新。

### 7.3 内部状态（定案字段）

```
state: 'idle' | 'scratching' | 'revealed'
dpr, cssW, cssH
coatCanvas, coatCtx            // 物理像素空间，ctx 基础变换恒为单位阵
coatImage: FabricImage         // objectCaching:false（双保险），selectable:false,
                               // evented:false（不参与选中/命中），无 clipPath/shadow/滤镜
lastPoint: {x,y} | null        // 物理像素
drawing: boolean
rafPending: boolean
needsMeasure: boolean
generation: number             // reset/destroy 自增，使挂起 rAF 作废
patternImage: HTMLImageElement // 涂层图案（crossOrigin anonymous），null 表示纯色
```

硬性约束（写进代码注释与评审 checklist）：

1. 涂层 FabricImage 永远不得加 clipPath / shadow / 滤镜 / 进 Group（见 §2.2、R12）。
2. 擦除只能发生在 `coatCtx`；任何 Fabric 拥有的 ctx（lower/upper）禁止手画（见 §2.4）。
3. 尺寸变更只走 `fabricCanvas.setDimensions`；禁止手改 Fabric canvas 的 width/height 属性与 style（见 §2.4、§4.5）。
4. 一切坐标换算只经过一个因子 `dpr = fabricCanvas.getRetinaScaling()`，不引入 viewportTransform。
5. `complete` 只在状态机迁移处触发一次（见 §3.3）。
6. 涂层 FabricImage 的 `width/height` 永远等于 CSS 逻辑宽高（其元素 coatCanvas 自身是物理像素尺寸）；resize 时随 `setElement(next,{width,height})` 一起更新（见 §4.5）。

### 7.4 初始化顺序（避免首帧错版）

1. `config.devicePixelRatio = Math.min(window.devicePixelRatio, dprCap)`（new Canvas 之前）；
2. `new Canvas(el, { width, height, backgroundColor: '', preserveObjectStacking:true, enableRetinaScaling:true, selection:false, renderOnAddRemove:true })`；
3. 预加载涂层图案（`crossOrigin='anonymous'`），成功与否都 resolve；
4. 创建 `coatCanvas`（backstore=cssW*dpr），铺底（纯色或 `cover` 画图）；
5. `new FabricImage(coatCanvas, { width: cssW, height: cssH, originX:'left', originY:'top', left:0, top:0, selectable:false, evented:false, objectCaching:false })`。两个必传点：
   - **width/height 必须显式传 CSS 逻辑值**：`FabricImage` 默认用元素自身像素尺寸（`_setWidthHeight` 取 `naturalWidth||element.width`，`node_modules/fabric/src/shapes/Image.ts:687-692`），而 coatCanvas 的元素尺寸是 `cssW*dpr`，不传会让涂层对象在 dpr=2 时放大 2 倍；对象逻辑宽高 + 主 ctx 自带的 dpr scale 才使物理像素一一对应。
   - **origin 必须显式设为 left/top**：v7 对象默认 `originX/originY = center`（`node_modules/fabric/src/shapes/Object/defaultValues.ts:67-68`），若用默认值再配 left/top:0，涂层会向左上偏移半个宽高；
6. `canvas.add(coatImage)` → 绑事件 → 首帧 `requestRenderAll()`。

### 7.5 关键时序

- move：写 coat 像素（插值）→ `needsMeasure=true` → 若 `!rafPending` 挂一个 rAF：`requestRenderAll()` 同帧或下一帧渲染，并在同回调末尾 measure→`onProgress`→阈值判定。
- up：立即 `measureNow()`（不等 rAF），保证最后一笔越线即时揭开。
- complete：`state='revealed'` → coatImage 淡出（对象 `animate('opacity',0,{duration:250})` 或 CSS 动画包裹容器）→ 淡出结束可选 `canvas.remove(coatImage)` → `onComplete()`。
- reset：`generation++` → 新建 coatCanvas 铺底 → `coatImage.setElement(newCoat, { width: cssW, height: cssH })`（必传逻辑宽高，理由同 §7.4）并把 opacity 归 1（若未 remove）或重新 add → `state='idle'` → `requestRenderAll()` → `onReset()`。

---

## 8. 证据索引（fabric@7.4.0 源码，node_modules 安装后对应路径）

| 结论 | 证据文件与行号 |
|---|---|
| 锁定版本 7.4.0 | `package-lock.json` → `node_modules/fabric.version = "7.4.0"` |
| renderAll/renderCanvas 流程、clearRect、单对场景 save/restore | `node_modules/fabric/src/canvas/StaticCanvas.ts:465-470`、`535-564`、`436-438` |
| requestRenderAll 的 rAF 合帧 | `node_modules/fabric/src/canvas/StaticCanvas.ts:478-494` |
| add/remove 触发 requestRenderAll | `node_modules/fabric/src/canvas/StaticCanvas.ts:220-233` |
| setDimensions / hasLostContext | `node_modules/fabric/src/canvas/StaticCanvas.ts:303-352` |
| retina scaling 取值与默认开启 | `node_modules/fabric/src/canvas/StaticCanvas.ts:271-273`；`src/canvas/StaticCanvasOptions.ts:172`；`src/env/index.ts:46-47`；`src/config.ts:29-30` |
| backstore 尺寸 = CSS×dpr 且 ctx.scale(dpr) | `node_modules/fabric/src/canvas/DOMManagers/util.ts:10-19`；`src/canvas/DOMManagers/CanvasDOMManager.ts:97-100` |
| 指针坐标为 CSS px（除以 retinaScaling） | `node_modules/fabric/src/canvas/SelectableCanvas.ts:1060-1097` |
| upper canvas 每帧清空、drawing 绘制位置 | `node_modules/fabric/src/canvas/SelectableCanvas.ts:396-441` |
| FabricImage 默认不走对象缓存 | `node_modules/fabric/src/shapes/Image.ts:630-632`、`597-601`；`src/shapes/Object/Object.ts:750-780` |
| 对象 render 的 save/restore 与 drawObject 直绘分支 | `node_modules/fabric/src/shapes/Object/Object.ts:649-672` |
| dirty 白名单与冒泡；isCacheDirty 清缓存副作用 | `node_modules/fabric/src/shapes/Object/Object.ts:611-628`、`911-934` |
| clipPath 强制独立缓存；inverted 用 destination-out；clip layer 每帧新建 | `node_modules/fabric/src/shapes/Object/Object.ts:750-766`、`799-817`、`844-890` |
| setElement 不置 dirty、不请求渲染；对象宽高取元素像素、需显式传逻辑尺寸 | `node_modules/fabric/src/shapes/Image.ts:238-256`、`687-692`；`_renderFill` 按逻辑宽高 drawImage：`Image.ts:634-663` |
| 对象默认 origin 为 center（涂层必须显式改 left/top） | `node_modules/fabric/src/shapes/Object/defaultValues.ts:67-68` |
| PencilBrush 画 upper canvas、越界丢弃、抬笔 add(Path) | `node_modules/fabric/src/brushes/PencilBrush.ts:83-113`、`275-296`；`src/brushes/BaseBrush.ts:99-103`、`146-153` |
| PatternBrush 仅改 strokeStyle 为 pattern | `node_modules/fabric/src/brushes/PatternBrush.ts`（`_setBrushStyles`、`createPath`） |
| Eraser 已不在 7.4.0 构建（mixin 仅条件编译片段，bundle 0 匹配） | `node_modules/fabric/src/mixins/eraser_brush.mixin.ts:1-20`；`node_modules/fabric/dist/fabric.mjs`（grep `eraser` = 0） |
| 主触摸过滤、document 级 move/up 注册、touch 阻止滚动 | `node_modules/fabric/src/canvas/Canvas.ts:602-616`、`618-693`、`744-765` |
| touch-action:none、upper 绝对定位覆盖 lower | `node_modules/fabric/src/canvas/DOMManagers/CanvasDOMManager.ts:30-49`、`85-99` |
| window resize 默认仅 calcOffset | `node_modules/fabric/src/canvas/Canvas.ts:171`、`794-797` |
| 默认项 renderOnAddRemove/enablePointerEvents/allowTouchScrolling | `node_modules/fabric/src/canvas/StaticCanvasOptions.ts:170-182`；`src/canvas/CanvasOptions.ts:284` |

> 复核方式：`npm ci` 后 `grep -n "<符号>" node_modules/fabric/src/<上表路径>`；行号以 7.4.0 为准，升级版本必须重新核对（R7）。
