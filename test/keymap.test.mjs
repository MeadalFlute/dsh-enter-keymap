/**
 * dsh-enter-keymap 单测（零依赖，直接 `node test/keymap.test.mjs` 运行）。
 *
 * 覆盖两层：
 *   1. 键位路由：DOM 探测能力全部换成桩，验证三种手势在各种守卫下的结果；
 *      事件的副作用（shiftKey 改写、preventDefault、合成 Ctrl+Enter 派发）都被记录后断言。
 *   2. 文案渲染：用极小的 React 壳真跑一遍 apply() 与 EnterKeymapRow，
 *      断言设置行渲染的是文案而不是原始 key（曾经真的显示过 row.title）。
 *
 * 为什么不用 `node --test`：DSH 沙箱下测试运行器 fork 子进程捕获 stdio 会 EPERM；
 * 这个文件自带极小的断言/汇总壳，行为等价且可直接当脚本跑。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/**
 * 平台 React 桩：保留元素树，让渲染断言能看到真实文案。
 * `useCallback` 直接执行（组件里只包了稳定引用），`useSyncExternalStore`
 * 读一次快照即可（测试不涉及并发重渲染）。
 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/**
 * 造一个设置存储桩。
 * @param {boolean} enabled - 初始开关。
 * @returns {object} store 桩。
 */
function makeStoreStub(enabled) {
  return {
    value: enabled,
    get: () => enabled,
    set: (next) => {
      enabled = next === true
    },
    subscribe: () => () => {},
  }
}

/**
 * 深度遍历 React 元素桩，收集所有字符串/数字子节点。
 * @param {unknown} node - 元素、数组或标量。
 * @param {string[]} [out] - 收集器。
 * @returns {string[]} 文本片段。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    collectText(node.children, out)
    return out
  }
  out.push(String(node))
  return out
}

/**
 * 渲染设置行组件并返回文本片段。
 * @param {object} props - 组件的 props。
 * @returns {string[]} 渲染出的文本。
 */
function renderRow(props) {
  return collectText(bundle.__testing.EnterKeymapRow(props))
}

/**
 * 最小 KeyboardEvent 桩：记录 init，让断言能检查合成事件的字段。
 * 真实浏览器里这里由平台 table 提供的全局构造函数承担。
 */
class KeyboardEventStub {
  /**
   * @param {string} type - 事件类型。
   * @param {object} [init] - 事件初始化字典。
   */
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
  }
}

/**
 * 沙箱 require：只解析本 bundle 会用到的模块。
 * @param {string} id - 模块名。
 * @returns {unknown} 模块桩。
 */
function sandboxRequire(id) {
  if (id === 'react') return reactStub
  throw new Error(`test sandbox: unexpected module request ${id}`)
}

/**
 * 在最小 CommonJS 沙箱里加载插件 bundle：桩掉 `window.__ModuleLoader__`，
 * 直接取得 factory 的返回值（module 体内没有全局副作用）。
 * @returns {object} 插件出口对象（含 __testing）。
 */
function loadBundle() {
  const source = readFileSync(bundlePath, 'utf8')
  const module = { exports: {} }
  const window = {
    // apply() 会挂全局监听器与插入样式标签；探针里只记录，不做真实 DOM 操作。
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: {
      load: (options) => {
        module.exports = options.factory(sandboxRequire)
      },
    },
  }
  // 只为 apply() 的样式注入服务：querySelector 返回 null 表示样式尚未插入。
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    head: { appendChild: () => {} },
  }
  const wrapper = new vm.Script(
    `(function (module, exports, require, window, document, KeyboardEvent) { ${source}\n })`,
    { filename: bundlePath },
  )
  wrapper.runInThisContext()(module, module.exports, sandboxRequire, window, document, KeyboardEventStub)
  return module.exports
}

const bundle = loadBundle()
const { routeEnter, onKeyDown, asShiftEnter } = bundle.__testing

/**
 * 造一个假的 keydown 事件，记录副作用。
 * @param {object} [init] - 字段覆盖。
 * @returns {object} 假事件。
 */
function makeEvent(init = {}) {
  return {
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    defaultPrevented: false,
    target: { fake: 'editor' },
    prevented: 0,
    stopped: 0,
    preventDefault() {
      this.prevented += 1
      this.defaultPrevented = true
    },
    stopImmediatePropagation() {
      this.stopped += 1
    },
    ...init,
  }
}

/**
 * 造一个假编辑器，记录派发出去的合成事件。
 * @returns {object} 假编辑器。
 */
function makeEditor() {
  return {
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event)
      return true
    },
  }
}

/**
 * 造 DOM 探测桩。
 * @param {object} [options] - inComposer 是否识别为 composer；menuVisible 菜单是否可见。
 * @returns {object} dom 桩。
 */
function makeDom(options = {}) {
  const { inComposer = true, menuVisible = false } = options
  const editor = makeEditor()
  return {
    editor,
    composerEditorOf: () => (inComposer ? editor : null),
    isTriggerMenuVisible: () => menuVisible,
  }
}

const enabled = () => true
const disabled = () => false

/** 已注册的用例。 @type {Array<{ name: string, run: () => void }>} */
const cases = []
/**
 * 注册一个用例。
 * @param {string} name - 用例名。
 * @param {() => void} run - 用例体。
 * @returns {void}
 */
function test(name, run) {
  cases.push({ name, run })
}

test('Enter 在 composer 内 → 换行（改写 shiftKey、不阻止默认、不派发）', () => {
  const dom = makeDom()
  const event = makeEvent()
  assert.equal(routeEnter(event, enabled, dom), 'newline')
  onKeyDown(event, enabled, dom)
  assert.equal(event.shiftKey, true, 'shiftKey 必须被改写为 true')
  assert.equal(event.prevented, 0, '不能阻止默认行为，否则原生换行消失')
  assert.equal(event.stopped, 0, '不能中断传播')
  assert.equal(dom.editor.dispatched.length, 0, '不应派发任何合成事件')
})

test('Ctrl+Enter / Cmd+Enter → 完全不处理，交给 DSH 原生加速手势', () => {
  for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
    const dom = makeDom()
    const event = makeEvent(init)
    assert.equal(routeEnter(event, enabled, dom), 'ignore')
    onKeyDown(event, enabled, dom)
    assert.equal(event.prevented, 0)
    assert.equal(event.stopped, 0)
    assert.equal(event.shiftKey, false)
    assert.equal(dom.editor.dispatched.length, 0)
  }
})

test('Alt+Enter → 不处理', () => {
  const dom = makeDom()
  assert.equal(routeEnter(makeEvent({ altKey: true }), enabled, dom), 'ignore')
})

test('Shift+Enter → 插队：阻止默认 + 中断传播 + 派发合成的 Ctrl+Enter', () => {
  const dom = makeDom()
  const event = makeEvent({ shiftKey: true })
  assert.equal(routeEnter(event, enabled, dom), 'steer')
  onKeyDown(event, enabled, dom)
  assert.equal(event.prevented, 1, '必须阻止原生换行')
  assert.equal(event.stopped, 1, '必须中断原事件传播')
  assert.equal(dom.editor.dispatched.length, 1, '必须派发一个合成事件')
  const synthetic = dom.editor.dispatched[0]
  assert.equal(synthetic.type, 'keydown')
  assert.equal(synthetic.key, 'Enter')
  assert.equal(synthetic.ctrlKey, true, '合成事件必须带 ctrlKey 才会走加速分支')
  assert.ok(!synthetic.shiftKey, '合成事件不能带 shiftKey，否则 Lexical 会插入换行')
  assert.equal(synthetic.bubbles, true)
  assert.equal(synthetic.cancelable, true)
})

test('开关关闭时任何手势都不处理', () => {
  const dom = makeDom()
  const plain = makeEvent()
  const shift = makeEvent({ shiftKey: true })
  for (const event of [plain, shift]) {
    assert.equal(routeEnter(event, disabled, dom), 'ignore')
    onKeyDown(event, disabled, dom)
    assert.equal(event.prevented, 0)
    assert.equal(event.stopped, 0)
  }
  assert.equal(dom.editor.dispatched.length, 0)
  assert.equal(plain.shiftKey, false)
})

test('不在 composer 内（例如提问卡片输入框）→ 不处理', () => {
  const dom = makeDom({ inComposer: false })
  for (const event of [makeEvent(), makeEvent({ shiftKey: true })]) {
    assert.equal(routeEnter(event, enabled, dom), 'ignore')
    onKeyDown(event, enabled, dom)
    assert.equal(event.prevented, 0)
    assert.equal(event.stopped, 0)
  }
})

test('触发菜单（/ 或 @）可见 → 放行，保证 Enter 能选中菜单项', () => {
  const dom = makeDom({ menuVisible: true })
  assert.equal(routeEnter(makeEvent(), enabled, dom), 'ignore')
  assert.equal(routeEnter(makeEvent({ shiftKey: true }), enabled, dom), 'ignore')
})

test('输入法组合中的回车一律放行', () => {
  const dom = makeDom()
  assert.equal(routeEnter(makeEvent({ isComposing: true }), enabled, dom), 'ignore')
  assert.equal(routeEnter(makeEvent({ keyCode: 229 }), enabled, dom), 'ignore')
})

test('已被别的捕获监听器处理过的事件不重复处理', () => {
  const dom = makeDom()
  assert.equal(routeEnter(makeEvent({ defaultPrevented: true }), enabled, dom), 'ignore')
})

test('非 Enter 键不受影响', () => {
  assert.equal(routeEnter(makeEvent({ key: 'a' }), enabled, makeDom()), 'ignore')
  assert.equal(routeEnter(makeEvent({ key: 'Escape' }), enabled, makeDom()), 'ignore')
})

test('asShiftEnter 改写失败时返回 false（调用方退化为不处理）', () => {
  const frozen = Object.freeze(makeEvent())
  assert.equal(asShiftEnter(frozen), false)
})

test('导出形状：name / inject / apply', () => {
  assert.equal(bundle.name, 'dsh-enter-keymap/client')
  assert.deepEqual(bundle.inject, ['slots', 'locale', 'settingsScope'])
  assert.equal(typeof bundle.apply, 'function')
})

//#region 文案（回归：设置行曾经显示原始 key row.title）

/**
 * 探针得到的 apply() 结果：注册进 locale 的字典、绑定出的 label、注册的 slot。
 * @returns {object} 探针结果。
 */
function probeApply() {
  const registered = new Map()
  const slots = []
  const ctx = {
    effect: (callback) => callback(),
    locale: {
      register: (ns, dicts) => {
        registered.set(ns, dicts)
        return () => {}
      },
      bind: (ns) => {
        const dicts = registered.get(ns)
        return (key, params) => {
          const value = dicts?.zh?.[key] ?? dicts?.en?.[key]
          return value === undefined ? key : value
        }
      },
    },
    slots: {
      inject: (name, contribute) => contribute(),
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    settingsScope: {
      bind: () => ({ getSnapshot: () => ({ status: 'unavailable', value: undefined }), subscribe: () => () => {}, set: async () => {} }),
    },
  }
  bundle.apply(ctx)
  return { registered, slots, label: slots[0]?.options.inject().label }
}

test('apply 会用 LOCALE_NS 注册双语字典并自己绑定 label', () => {
  const probe = probeApply()
  const dicts = probe.registered.get(bundle.__testing.LOCALE_NS)
  assert.ok(dicts, '字典必须注册在 LOCALE_NS 命名空间下')
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])
  assert.equal(typeof probe.label, 'function', 'inject 必须提供自己绑定的 label')
})

test('label 返回真实文案而不是原始 key', () => {
  const { label } = probeApply()
  assert.equal(label('row.title'), '编写器键位')
  assert.equal(label('row.on'), '已启用')
  assert.equal(label('row.off'), '已禁用')
})

test('设置行渲染出的是文案不是 key（回归用例）', () => {
  const { label } = probeApply()
  const rendered = JSON.stringify(renderRow({ store: makeStoreStub(true), label }))
  for (const raw of ['row.title', 'row.description', 'row.on', 'row.off']) {
    assert.ok(!rendered.includes(`"${raw}"`), `渲染结果里不应出现原始 key ${raw}`)
  }
  assert.ok(rendered.includes('编写器键位'), '应渲染标题文案')
  assert.ok(rendered.includes('Enter 换行'), '应渲染键位说明文案')
  assert.ok(rendered.includes('已启用'), '启用时应渲染状态文案')
})

test('说明只有一行，键位与行为不重复（回归用例）', () => {
  const { label } = probeApply()
  const texts = renderRow({ store: makeStoreStub(true), label })
  // 结构：标题 + 一行说明 + 按钮文案（按钮里还有状态点）。
  assert.equal(texts.length, 3, `设置行应只有标题/说明/按钮三段文本，实际：${JSON.stringify(texts)}`)
  assert.equal(texts[0], label('row.title'))
  assert.equal(texts[1], label('row.description'))
  assert.equal(texts[2], label('row.on'))
  assert.ok(!('row.keys' in bundle.__testing.DICTIONARIES.zh), '不应再保留多余的 row.keys 文案')
})

test('两本字典的 key 集合一致，且覆盖组件用到的每个 key', () => {
  const { zh, en } = bundle.__testing.DICTIONARIES
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 的 key 必须一一对应')
  // 键是扁平点号形式（DSH 的查找是 dicts[locale][key] 一次取值），值是字符串。
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string', `zh.${key} 必须是字符串`)
    assert.equal(typeof en[key], 'string', `en.${key} 必须是字符串`)
  }
  for (const key of ['row.title', 'row.description', 'row.on', 'row.off', 'row.enable', 'row.disable']) {
    assert.ok(key in zh, `zh 字典缺少 ${key}`)
    assert.ok(key in en, `en 字典缺少 ${key}`)
  }
})

test('关闭状态下按钮文案走 row.off', () => {
  const { label } = probeApply()
  const rendered = JSON.stringify(renderRow({ store: makeStoreStub(false), label }))
  assert.ok(rendered.includes('已禁用'))
})

//#endregion

let failed = 0
for (const item of cases) {
  try {
    item.run()
    console.log(`  ok  ${item.name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${item.name}`)
    console.log(`       ${error.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
