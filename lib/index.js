/**
 * dsh-enter-keymap 的 Host 端（服务端半）。
 *
 * 浏览器端只负责键位拦截与设置行；偏好要真正持久化，需要 Host 侧先注册同名
 * namespace，否则 `ctx.settingsScope.bind()` 拿到的是 `unavailable` 快照
 * （浏览器端仍可用，只是刷新后回到默认值）。
 *
 * 这里只有一件事：把 namespace + schema 注册进 settings 服务。没有路由、
 * 没有工具、没有提示词、没有子进程。
 *
 * @module dsh-enter-keymap
 */
import z from 'schemastery'

/** 与浏览器端共用的设置 namespace，写入 $DSH_HOME/settings.yaml。 */
export const ENTER_KEYMAP_SETTINGS_NAMESPACE = 'enter-keymap'

/**
 * 设置的 schema。
 * `enabled: false` 时浏览器端完全不拦截按键，恢复 DSH 原生键位。
 * 与 DSH 自身的做法一致（`z.object({ field: z.boolean() })`），刻意不加
 * `.default()`：缺省值只在代码里兜底，避免同一默认值写在两处。
 */
export const EnterKeymapSettingsSchema = z.object({
  /** 是否启用自定义键位（Enter 换行 / Ctrl+Enter 发送 / Shift+Enter 插队）。 */
  enabled: z.boolean(),
})

/**
 * 注册设置 namespace。
 *
 * settings 服务由 host 组合或 profile 的 settings-file 行提供；不存在时
 * `ctx.inject` 的回调不会被调用，插件安静退化为「仅浏览器端、不持久化」。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(ENTER_KEYMAP_SETTINGS_NAMESPACE, EnterKeymapSettingsSchema)
  })
}
