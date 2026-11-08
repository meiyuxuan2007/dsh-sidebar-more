/**
 * dsh-sidebar-more — host half.
 *
 * 这个插件只在浏览器半边工作：宿主侧不需要任何服务，保留一个空的 apply 让
 * Loader 能正常挂载 entry（与 dsh-ask-selection 的做法一致）。
 */
export function apply() {}
