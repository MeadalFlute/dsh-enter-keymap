/**
 * dsh-enter-keymap — 浏览器端（Client 半）。
 *
 * 目标键位：
 *   - Enter            → 换行（不再发送）
 *   - Ctrl / Cmd+Enter  → 发送（交给 DSH 原生处理，语义完全不变）
 *   - Shift+Enter      → 插队发送（等价于 DSH 的 Ctrl/Cmd+Enter 手势：
 *                        忙时 steer 队列，空闲时就是普通发送）
 *
 * 实现要点（按 DSH 0.1.6-alpha.2 的 composer 实现推导）：
 *   1. 在 `window` 的 **捕获阶段** 监听 keydown：一定早于 ui-conversation 的
 *      `document` 捕获监听器和 Lexical/React 的监听器，不受客户端插件加载顺序影响。
 *   2. composer 的键位处理挂在 Lexical 的 KEY_ENTER_COMMAND 上，第一件事就是
 *      `if (event.shiftKey === true) return false` → 交给 Lexical 执行
 *      INSERT_LINE_BREAK。所以「Enter 换行」只需把事件的 `shiftKey` 读成 true
 *      （沿用社区插件 dsh-ctrl-enter-submit 在 0.1.2+ 上已验证的做法）。
 *   3. 「Shift+Enter 插队」不能靠改字段（改 shiftKey 会变换行，改 ctrlKey 又挡不住
 *      Lexical 的换行插入）。做法是拦下原事件，再合成一个 `ctrlKey: true` 的
 *      Enter keydown：composer 的 gate 处理器走 accelerated 分支 →
 *      `steerQueue()` 或 `submit('steer')`。
 *   4. 合成事件由 React 18 挂在 `#root` 的捕获监听器接收，因此只要从编辑器元素
 *      派发、带 bubbles + cancelable 即可被 composer 处理。
 *   5. IME：`isComposing` / keyCode 229 一律放行，绝不吞掉输入法的回车。
 *   6. 触发菜单（`/`、`@`）打开时放行，Enter 仍可选中菜单项。
 *
 * 文案：**不用**框架注入的 `t`。slot 宿主会按自己的规则合成 `t`，实测在同一个
 * `locale:` 命名空间下会查不到本插件的字典而回显 key（设置行显示成 row.title）。
 * 这里改为在 `apply` 里用 `ctx.locale.bind(LOCALE_NS)` 自己绑定，并以 `label`
 * 这个自有 prop 名传给组件，彻底避开宿主 props 合成的覆盖。
 *
 * 出口形状为 `name` / `inject` / `apply`（无 default export）：DSH 的模块加载器
 * 提供 CommonJS 的 `module` / `require`，本文件在有 `module.exports` 时赋值。
 *
 * @module dsh-enter-keymap/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-enter-keymap',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    /** 插件 id，与 package.json / cordis.patch.yml 中的 name 对应。 */
    const PLUGIN_ID = 'dsh-enter-keymap'

    /** 语言字典 namespace（本插件自己拥有）。 */
    const LOCALE_NS = 'enter-keymap'

    /** 浏览器正在处理输入法组合时的 keyCode。 */
    const IME_PROCESSING_KEYCODE = 229

    /**
     * 本插件拥有的双语文案。
     *
     * 必须是**扁平的点号 key**：DSH 的 locale 字典就是 `Record<string, string>`，
     * 查找走 `dicts[locale][key]` 一次取值。写成嵌套对象会永远查不到，
     * 于是 `t()` 按设计回显 key —— 设置行就会显示成 `row.title`。
     */
    const DICTIONARIES = {
      zh: {
        'row.title': '编写器键位',
        'row.description': 'Enter 换行，Ctrl+Enter 发送，Shift+Enter 插队发送。',
        'row.on': '已启用',
        'row.off': '已禁用',
        'row.enable': '启用这套键位',
        'row.disable': '恢复 DSH 原生键位',
      },
      en: {
        'row.title': 'Composer keymap',
        'row.description': 'Enter inserts a newline, Ctrl+Enter sends, Shift+Enter sends as a steer.',
        'row.on': 'On',
        'row.off': 'Off',
        'row.enable': 'Enable this keymap',
        'row.disable': 'Restore the DSH default keymap',
      },
    }

    //#region 设置存储

    /**
     * 0.2.x 移除了浏览器侧的 `settingsScope`（Host 的 `settings.register` 也一并
     * 换成 SettingsForms），本插件只需要一个布尔开关，于是改存浏览器
     * localStorage：同一台机器、同一个浏览器配置下跨重启保留，多个窗口之间用
     * `storage` 事件同步。
     */
    const STORAGE_KEY = PLUGIN_ID + ':enabled'

    /**
     * 读取持久化的开关值；读不到或抛错时按启用处理。
     * @returns {boolean} 是否启用自定义键位。
     */
    function readStoredEnabled() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== 'false'
      } catch {
        return true
      }
    }

    /**
     * 极小的可订阅 store，接口与旧版 settings scope 包装保持一致。
     * @returns {{ get: () => boolean, set: (value: boolean) => void, subscribe: (listener: () => void) => () => void, dispose: () => void }}
     */
    function createEnabledStore() {
      let value = readStoredEnabled()
      const listeners = new Set()

      const publish = (next) => {
        if (next === value) return
        value = next
        for (const listener of [...listeners]) listener()
      }

      // 其它窗口改了开关时同步过来（localStorage 的 storage 事件不发给写入方自己）。
      const onStorage = (event) => {
        if (event.key !== STORAGE_KEY) return
        publish(event.newValue !== 'false')
      }
      window.addEventListener('storage', onStorage)

      return {
        get: () => value,
        set: (next) => {
          const resolved = next === true
          try {
            window.localStorage.setItem(STORAGE_KEY, String(resolved))
          } catch {
            // 隐私模式等不可写场景：只在本次页面内生效。
          }
          publish(resolved)
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        dispose: () => window.removeEventListener('storage', onStorage),
      }
    }

    //#endregion

    //#region 键位拦截

    /**
     * 是否处于输入法组合状态（中日韩输入等）。
     * @param {KeyboardEvent} event - 原始 keydown。
     * @returns {boolean} true 表示正在组合。
     */
    function isComposing(event) {
      return event.isComposing || event.keyCode === IME_PROCESSING_KEYCODE
    }

    /**
     * 事件目标所属的 composer 编辑器；不属于 composer 时返回 null。
     *
     * DSH 的编写器卡片带 `[data-composer-card]`，DSH ≥ 0.1.2 的编辑器是
     * `contenteditable` 的 `[data-composer-input]`。提问卡片的单行输入与选择
     * 按钮一律不碰（那里回车的语义归 ui-user-questions）。
     *
     * @param {EventTarget | null} target - keydown 的目标。
     * @returns {?HTMLElement} 可编辑的 composer 编辑器元素。
     */
    function composerEditorOf(target) {
      if (!(target instanceof Element)) return null
      if (target.closest('[data-question-key]') !== null) return null
      if (target.closest('[data-composer-card]') === null) return null
      const editor = target.closest('[data-composer-input], [contenteditable="true"]')
      if (editor !== null && editor.isContentEditable === true) return editor
      return null
    }

    /**
     * 触发菜单（`/` 命令、`@` 引用）当前是否可见。
     *
     * 菜单由 ui-input-trigger 挂在 composer 卡片内（`[data-trigger-menu]` 或
     * `role="listbox"`）。用 `getClientRects()` 判断可见性，避免 `offsetParent`
     * 对 fixed 定位元素返回 null 造成的误判。
     *
     * @returns {boolean} true 表示此刻回车属于菜单。
     */
    function isTriggerMenuVisible() {
      const card = document.querySelector('[data-composer-card]')
      if (card === null) return false
      const menu = card.querySelector('[data-trigger-menu], [role="listbox"]')
      return menu instanceof Element && menu.getClientRects().length > 0
    }

    /**
     * 让真实事件的 `shiftKey` 读成 true，使 DSH 的键位走换行分支。
     *
     * 只改读取结果：不 preventDefault、不 stopPropagation，浏览器仍会执行原生
     * 换行插入，编辑器随后把它归一化进自己的模型 —— 与用户亲手按 Shift+Enter
     * 完全一致。
     *
     * @param {KeyboardEvent} event - 原始 keydown。
     * @returns {boolean} true 表示改写成功。
     */
    function asShiftEnter(event) {
      try {
        Object.defineProperty(event, 'shiftKey', { value: true, configurable: true })
      } catch {
        return false
      }
      return event.shiftKey === true
    }

    /**
     * 合成一个「Ctrl+Enter」并派发到同一个编辑器，触发 DSH 的插队手势。
     * @param {HTMLElement} editor - composer 编辑器元素。
     * @returns {void}
     */
    function dispatchAcceleratedEnter(editor) {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      )
    }

    /**
     * 捕获阶段的 keydown 决策（纯函数：DOM 能力全部由 dom 参数注入，便于单测）。
     *
     * @param {KeyboardEvent} event - 原生事件。
     * @param {() => boolean} isEnabled - 读取实时开关。
     * @param {{ composerEditorOf: (target: unknown) => ?HTMLElement, isTriggerMenuVisible: () => boolean }} dom - DOM 探测能力。
     * @returns {'ignore' | 'newline' | 'steer'} 本次回车应该做什么。
     */
    function routeEnter(event, isEnabled, dom) {
      if (!isEnabled()) return 'ignore'
      if (event.key !== 'Enter') return 'ignore'
      if (event.defaultPrevented) return 'ignore'
      if (isComposing(event)) return 'ignore'
      if (dom.composerEditorOf(event.target) === null) return 'ignore'
      // 菜单打开时回车属于菜单，放行。
      if (dom.isTriggerMenuVisible()) return 'ignore'
      // Ctrl / Cmd / Alt 组合保持 DSH 原生语义（Ctrl+Enter = 发送 / 插队）。
      if (event.ctrlKey || event.metaKey || event.altKey) return 'ignore'
      return event.shiftKey ? 'steer' : 'newline'
    }

    /**
     * 执行 {@link routeEnter} 决定的动作。
     * @param {KeyboardEvent} event - 原生事件。
     * @param {() => boolean} isEnabled - 读取实时开关。
     * @param {{ composerEditorOf: (target: unknown) => ?HTMLElement, isTriggerMenuVisible: () => boolean }} dom - DOM 探测能力。
     * @returns {void}
     */
    function onKeyDown(event, isEnabled, dom) {
      const decision = routeEnter(event, isEnabled, dom)
      if (decision === 'ignore') return

      const editor = dom.composerEditorOf(event.target)
      if (editor === null || editor === undefined) return

      if (decision === 'steer') {
        // Shift+Enter → 插队发送：挡掉原生换行，改发一个 Ctrl+Enter。
        event.preventDefault()
        event.stopImmediatePropagation()
        dispatchAcceleratedEnter(editor)
        return
      }

      // Enter → 换行；改写失败时退化为「什么都不做」，由浏览器默认的
      // contenteditable 换行兜底，绝不会误发送。
      if (asShiftEnter(event)) return
      event.stopImmediatePropagation()
    }

    /**
     * 安装全局键位拦截。
     * @param {() => boolean} isEnabled - 读取实时开关。
     * @returns {() => void} 卸载函数。
     */
    function installKeymap(isEnabled) {
      const dom = { composerEditorOf, isTriggerMenuVisible }
      const handler = (event) => onKeyDown(event, isEnabled, dom)
      // capture = true 且挂在 window：传播路径最外层，先于其它监听器。
      window.addEventListener('keydown', handler, true)
      return () => window.removeEventListener('keydown', handler, true)
    }

    //#endregion

    //#region 设置行 UI

    /** 行样式：复用 DSH 设计 token，视觉上与原生设置行一致。 */
    const CSS = [
      '.dsh-enter-keymap-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))}',
      '.dsh-enter-keymap-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}',
      '.dsh-enter-keymap-title{color:var(--dsw-alias-label-primary, CanvasText);font-size:14px;font-weight:400;line-height:22px}',
      '.dsh-enter-keymap-desc{color:var(--dsw-alias-label-tertiary, GrayText);font-size:12px;font-weight:400;line-height:18px}',
      '.dsh-enter-keymap-toggle{background:var(--dsw-alias-bg-module-platform, rgb(127 127 127 / 12%));color:var(--dsw-alias-label-primary, CanvasText);cursor:pointer;border:1px solid transparent;border-radius:18px;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;display:inline-flex;align-items:center;gap:8px;white-space:nowrap}',
      '.dsh-enter-keymap-toggle:hover{background:var(--dsw-alias-interactive-bg-hover, rgb(127 127 127 / 20%))}',
      '.dsh-enter-keymap-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, Highlight);outline-offset:2px}',
      '.dsh-enter-keymap-toggle[data-on="true"]{border-color:var(--dsw-alias-brand-primary, Highlight)}',
      '.dsh-enter-keymap-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary, GrayText);flex:none}',
      '.dsh-enter-keymap-toggle[data-on="true"] .dsh-enter-keymap-dot{background:var(--dsw-alias-brand-primary, Highlight)}',
    ].join('\n')

    /** 样式标签 id，用于去重与卸载。 */
    const STYLE_ID = PLUGIN_ID + ':settings-row'

    /**
     * 注入一次行样式。
     * @returns {() => void} 卸载函数。
     */
    function installStyles() {
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) {
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /**
     * `设置 → 通用` 里的一行开关。
     *
     * `label` 是本插件自己绑定的翻译函数（见文件头「文案」一节）；
     * 不用宿主注入的 `t`，避免其 props 合成规则把文案查成原始 key。
     *
     * @param {object} props - 组合后的 slot props（含本插件 inject 的 store 与 label）。
     * @returns {import('react').ReactElement} 设置行元素。
     */
    function EnterKeymapRow({ store, label }) {
      const subscribe = React.useCallback((listener) => store.subscribe(listener), [store])
      const getSnapshot = React.useCallback(() => store.get(), [store])
      const enabled = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      // 只有一行说明：键位与行为写在一起。native 行也是「标题 + 一行说明 + 控件」，
      // 再添一行键位图例只会把同一件事说两遍。
      return React.createElement(
        'div',
        { className: 'dsh-enter-keymap-row' },
        React.createElement(
          'div',
          { className: 'dsh-enter-keymap-text' },
          React.createElement('div', { className: 'dsh-enter-keymap-title' }, label('row.title')),
          React.createElement('div', { className: 'dsh-enter-keymap-desc' }, label('row.description')),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-enter-keymap-toggle',
            'data-on': String(enabled),
            'aria-pressed': enabled,
            title: enabled ? label('row.disable') : label('row.enable'),
            onClick: () => store.set(!enabled),
          },
          React.createElement('span', { className: 'dsh-enter-keymap-dot', 'aria-hidden': 'true' }),
          enabled ? label('row.on') : label('row.off'),
        ),
      )
    }

    //#endregion

    //#region 插件入口

    /** 需要的客户端服务；缺任一个插件都不会被激活。 */
    const inject = ['slots', 'locale']

    /**
     * 客户端插件入口。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTIONARIES), PLUGIN_ID + ': dictionaries')

      const store = createEnabledStore()
      ctx.effect(() => () => store.dispose(), PLUGIN_ID + ': storage listener')
      ctx.effect(() => installKeymap(() => store.get()), PLUGIN_ID + ': keydown interceptor')
      ctx.effect(() => installStyles(), PLUGIN_ID + ': row styles')

      // 自己绑定翻译函数：`bind` 按设计返回按 namespace 稳定的引用，
      // 且每次调用都读当前语言，所以语言切换后无需重新注册 slot。
      const label = ctx.locale.bind(LOCALE_NS)

      // 0.2.x 的 settings.general.item 不向注册者传任何 props：文案、当前值与
      // 写入路径都由行自己负责。这里用闭包把 store / label 交给行组件。
      const Row = () => React.createElement(EnterKeymapRow, { store, label })

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'enter-keymap', order: 21 }, Row),
      )
    }

    module.exports = { name: PLUGIN_ID + '/client', inject, apply }
    // 测试用出口：不参与 cordis 生命周期，仅让单测驱动纯函数、文案表与设置行组件。
    module.exports.__testing = {
      routeEnter,
      onKeyDown,
      asShiftEnter,
      isComposing,
      EnterKeymapRow,
      DICTIONARIES,
      LOCALE_NS,
    }
    return module.exports
  },
})
