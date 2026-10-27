/**
 * dsh-bus-viewer · 宿主半边。
 *
 * 本插件只贡献浏览器端界面（bus-report 看板的侧边栏入口 + 主面板），
 * 宿主侧无需任何服务或配置，因此 apply 是空的——但 Loader 需要在宿主树里
 * 有一行，浏览器 bundle 才能经 `exports["./client"]` 被 /plugins 提供。
 */
export function apply() {}
