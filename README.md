# dsh-enter-keymap

给 DSH Web GUI 换一套编写器键位：**Enter 换行 · Ctrl+Enter 发送 · Shift+Enter 插队发送**。
可在 **设置 → 通用 → 编写器键位** 里随时开关，关掉即刻恢复 DSH 原生键位。

| 按键 | 行为 |
| --- | --- |
| `Enter` | 在草稿里换行（不再直接发送） |
| `Ctrl` / `Cmd` + `Enter` | 发送。完全沿用 DSH 原生语义：空闲时直接发送；Agent 忙且队列非空时按 DSH 的加速手势插队 |
| `Shift` + `Enter` | 插队发送。等价于按 `Ctrl`/`Cmd` + `Enter`：忙时 steer（把队列里的消息插进当前回合），空闲时就是普通发送 |
| `Alt` + `Enter`、输入法组合中的回车、`/` `@` 菜单打开时的回车 | 一律放行，保持 DSH 原生行为 |

## 安装

走官方插件通道（会自动登记 profile 的 `dsh.profile.bundles` 并插入 Loader 行，无需手改任何 profile 文件）：

```sh
# 从 GitHub 装
dsh plugin --profile web add github:MeadalFlute/dsh-enter-keymap

# 或从 npm 装
dsh plugin --profile web add dsh-enter-keymap
```

装完**重启 DSH 实例**（Host 只在启动时扫描一次 Loader 条目），然后整页刷新。
卸载：`dsh plugin --profile web remove dsh-enter-keymap`，同样重启。

> 本机（DSH Launcher 布局）实测 `dsh plugin` 会因 pnpm store 探测失败报
> `ERR_PNPM_UNEXPECTED_STORE`；那种情况下手工等价安装见文末「本地开发装法」。

## 为什么会有这个插件

DSH 自带 **设置 → 通用 → Composer Enter**（`ui-conversation.busyEnter`），但它只决定
「Agent 忙时普通 Enter 是排队还是插队」，**改不了「Enter 到底发不发送」**——原生 Enter 永远直接发送。
社区另有一个 [SA1992X/dsh-ctrl-enter-submit](https://github.com/SA1992X/dsh-ctrl-enter-submit)（MIT），
它实现了「Enter 换行 + Ctrl+Enter 发送」，但明确**不支持** Shift+Enter（它的注释写着
「Shift+Enter 不是提交，DSH 键位表把带 shift 的 Enter 当作换行」）。
本插件在同样的思路上补上了 Shift+Enter 插队，并加了设置开关。

## 实现原理

DSH 0.1.6-alpha.2 的编写器是 Lexical 编辑器，键位注册在 `KEY_ENTER_COMMAND` 上，处理顺序是：

```
if (event.shiftKey === true) return false          // 交给 Lexical 插入换行
if (isComposing(event)) return true                // 输入法组合中
if (arbitrate('enter') !== 'pass') return true     // 菜单拦截
event.preventDefault()
if (!canSubmit()) return true
submit(event.ctrlKey === true || event.metaKey === true)   // accelerated = Ctrl/Cmd
```

于是：

1. **Enter → 换行**：只要把事件对象的 `shiftKey` 读成 `true`，DSH 就会走换行分支，
   浏览器原生换行插入照常发生，编辑器再把它归一化进自己的模型。
   （`Object.defineProperty(event, 'shiftKey', { value: true })`，与 dsh-ctrl-enter-submit 在 0.1.2+ 上的做法一致。）
2. **Shift+Enter → 插队**：光改字段做不到（改 `shiftKey` 变换行、改 `ctrlKey` 又挡不住 Lexical 插换行）。
   所以拦下原事件（`preventDefault` + `stopImmediatePropagation`），再往同一个编辑器
   `dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`
   —— composer 的 gate 处理器收到后会走 `accelerated` 分支：`canSteerQueue` 时 `steerQueue()`，
   否则 `submit(resolveSubmitMode(...))`。
   React 18 的事件委托挂在 `#root` 的捕获阶段，所以从编辑器元素派发、带 `bubbles` 的合成事件能被 composer 收到。
3. **监听位置**：挂在 `window` 的**捕获阶段**。事件传播是 `window → document → … → 编辑器`，
   因此一定早于 ui-conversation 挂在 `document` 上的捕获监听器和 React/Lexical 的监听器，
   不受客户端插件加载顺序影响。
4. **不越界**：只在 `[data-composer-card]` 内的可编辑元素上生效；Agent 提问卡片的输入框与选择按钮
   （`[data-question-key]`）一律不碰。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包声明：`main`（Host 半）、`./client`（浏览器半）、`dsh.client`、`dsh.bundle.patch` |
| `lib/index.js` | Host 半：向 settings 服务注册 namespace `enter-keymap` 与 schema，使开关持久化到 `$DSH_HOME/settings.yaml` |
| `lib/client.js` | 浏览器半：`window` 捕获阶段键位拦截 + 「设置 → 通用」开关行（手写 bundle，出口为 `name`/`inject`/`apply`） |
| `cordis.patch.yml` | bundle patch：往 Loader 树插入 `enter-keymap` 行 |
| `test/keymap.test.mjs` | 键位路由 + 文案渲染单测（零依赖，直接 `node` 跑） |

## 自检

```sh
node test/keymap.test.mjs
```

18 条用例：12 条键位路由（Enter 换行、Ctrl/Cmd+Enter 放行、Shift+Enter 合成 Ctrl+Enter、
开关关闭、非 composer 目标、菜单打开、输入法组合、事件已被处理、非 Enter 键、导出形状），
外加 6 条文案渲染回归（字典注册、`label` 返回真实文案、设置行渲染不含原始 key、
说明只有一行不重复、双语 key 一一对应、关闭态文案）。

## 说明与已知限制

- **文案用自己绑定的翻译函数**。DSH 的 locale 字典是**扁平的点号 key → 字符串**
  （`{"settings.enter.title": "…"}`），查找就是 `dicts[locale][key]` 一次取值：
  写成嵌套对象会永远查不到，`t()` 按设计回显 key，设置行就会显示成 `row.title`。
  所以这里用扁平表，并在 `apply` 里 `ctx.locale.bind('enter-keymap')` 自己绑定，
  以 `label` 这个自有 prop 名传进组件（组件闭包持有），避开 slot 宿主的 props 合成规则；
  回归用例会断言渲染结果里不出现 `row.title` 这类原始 key。
- Host 半是**必需**的：没有它，`ctx.settingsScope.bind()` 拿到的是 `unavailable` 快照，
  开关仍能在当前页面生效，但刷新后回到默认（已启用），不会写进 `settings.yaml`。
- Shift+Enter 在「Agent 忙但草稿为空」时，会像 DSH 的 Ctrl+Enter 一样**冲刷队列**（steer 队列里已有消息），
  而不是发送空消息 —— 这是 DSH 原生加速手势的语义，插件刻意保持一致。
- 验证环境为 DSH `0.1.6-alpha.2`。若 DSH 以后把 Shift+Enter 改成别的语义，或把 `busyEnter` 改成三态，
  本插件需要同步更新；拦截点全部集中在 `lib/client.js` 的 `routeEnter`，单测可直接覆盖改动。

## 本地开发装法

`dsh plugin` 不可用时，用 `scripts/install.mjs` 手工完成等价的三件事
（在 profile 的 `node_modules` 建 junction、登记 `link:` 依赖与 `dsh.profile.bundles`、
给插件自己建 `schemastery` junction —— Cordis 加载器 import 的是插件的真实路径，
Host 半的裸模块导入要从插件目录往上找）：

```sh
node scripts/install.mjs --profile web
```

测试与源码都在仓库里（npm 包的 `files` 只含 `lib` 与 patch，测试不进包）。
