/**
 * dsh-enter-keymap 的 Host 端（服务端半）。
 *
 * 历史：0.1.x 时这里用 `ctx.settings.register(ns, schema)` 注册设置 namespace，
 * 浏览器半再通过 `ctx.settingsScope` 读写。0.2.x 把设置系统换成 SettingsForms，
 * 浏览器侧也不再暴露 settingsScope，于是键位开关改由浏览器半自己用 localStorage
 * 持久化（见 `lib/client.js`）。
 *
 * 现在 Host 半只保留一个空的 apply：bundle 行需要一个可加载的模块入口，键位逻辑
 * 全部在浏览器半，这样不依赖任何一版设置 API。
 *
 * @module dsh-enter-keymap
 */

/**
 * Host 插件入口。
 *
 * 不注册服务、不注册路由、不注入工具：插件的全部行为都在 Web 页面里。
 *
 * @returns {void}
 */
export function apply() {}
