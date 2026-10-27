/**
 * dsh-bus-viewer · 浏览器半边。
 *
 * 贡献两处 slot：
 *   sidebar.panellist   侧边栏里的一枚图标（id = bus-report）
 *   main (keyed)        与图标同 id 的主面板页面
 * 这两个 slot 用同一个 id 串起来——点图标即把主栏切到该面板。
 */
window.__ModuleLoader__.load({
	id: "dsh-bus-viewer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsx = require("react/jsx-runtime");

		/** 侧边栏图标 id，同时是主面板 key。 */
		const PANEL_ID = "bus-report";
		const DEFAULT_URL = "http://127.0.0.1:8787/ba-bus-communication.html";
		const STORAGE_KEY = "dsh-bus-viewer.url";
		const STYLE_ID = "dsh-bus-viewer-style";

		const CSS = [
			".dsh-busv{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsh-color-bg,#0f1115)}",
			".dsh-busv-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.25);flex:0 0 auto;font:12px/1.4 system-ui,sans-serif}",
			".dsh-busv-url{flex:1 1 auto;min-width:0;padding:4px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:12px ui-monospace,monospace}",
			".dsh-busv-btn{padding:4px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font:12px system-ui,sans-serif;white-space:nowrap}",
			".dsh-busv-btn:hover{background:rgba(128,128,128,.15)}",
			".dsh-busv-btn:disabled{opacity:.5;cursor:default}",
			".dsh-busv-status{margin-left:auto;color:#8a93a5;font-size:11px;white-space:nowrap}",
			".dsh-busv-status[data-state=down]{color:#ffc078}",
			".dsh-busv-body{position:relative;flex:1 1 auto;min-height:0;display:flex}",
			".dsh-busv-frame{flex:1 1 auto;width:100%;border:0;background:#fff;min-height:0}",
			".dsh-busv-tip{position:absolute;inset:auto 12px 12px 12px;padding:10px 12px;border-radius:8px;background:#322616;border:1px solid #6b4a2f;color:#ffc078;font:12px/1.6 system-ui,sans-serif}",
			".dsh-busv-tip code{font-family:ui-monospace,monospace;background:rgba(0,0,0,.25);padding:1px 5px;border-radius:4px}"
		].join("\n");

		function readUrl() {
			try {
				return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_URL;
			} catch {
				return DEFAULT_URL;
			}
		}

		function writeUrl(url) {
			try {
				window.localStorage.setItem(STORAGE_KEY, url);
			} catch {
				/* 隐私模式下写不了，忽略 */
			}
		}

		/** 侧边栏图标：三条消息线 + 一个节点，和「沟通记录」语汇一致。 */
		function BusViewerIcon(props) {
			const size = (props && props.size) || 18;
			return jsx.jsx("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx.jsx("path", { key: "a", d: "M4 6h10" }),
					jsx.jsx("path", { key: "b", d: "M4 12h16" }),
					jsx.jsx("path", { key: "c", d: "M4 18h7" }),
					jsx.jsx("circle", { key: "d", cx: 18, cy: 6, r: 2 }),
					jsx.jsx("circle", { key: "e", cx: 14, cy: 18, r: 2 })
				]
			});
		}

		/** 主面板：地址栏 + iframe + 失联提示。 */
		function BusViewerPanel() {
			const [url, setUrl] = react.useState(readUrl);
			const [draft, setDraft] = react.useState(readUrl);
			const [nonce, setNonce] = react.useState(0);
			const [state, setState] = react.useState("probing");

			// 探活：no-cors 下只有网络层失败才会 reject —— 正好区分「服务没起」
			react.useEffect(() => {
				let alive = true;
				setState("probing");
				fetch(url, { mode: "no-cors", cache: "no-store" })
					.then(() => alive && setState("ok"))
					.catch(() => alive && setState("down"));
				return () => {
					alive = false;
				};
			}, [url, nonce]);

			const apply = react.useCallback(() => {
				const next = (draft || "").trim() || DEFAULT_URL;
				writeUrl(next);
				setUrl(next);
				setNonce((n) => n + 1);
			}, [draft]);

			const reload = react.useCallback(() => setNonce((n) => n + 1), []);

			const onKey = react.useCallback(
				(e) => {
					if (e.key === "Enter") apply();
				},
				[apply]
			);

			const src = nonce ? url + (url.indexOf("?") >= 0 ? "&" : "?") + "_r=" + nonce : url;

			return jsx.jsx("div", {
				className: "dsh-busv",
				children: [
					jsx.jsx("div", {
						key: "bar",
						className: "dsh-busv-bar",
						children: [
							jsx.jsx("input", {
								key: "input",
								className: "dsh-busv-url",
								value: draft,
								spellCheck: false,
								onChange: (e) => setDraft(e.target.value),
								onKeyDown: onKey,
								placeholder: DEFAULT_URL
							}),
							jsx.jsx("button", {
								key: "apply",
								type: "button",
								className: "dsh-busv-btn",
								onClick: apply,
								children: "应用"
							}),
							jsx.jsx("button", {
								key: "reload",
								type: "button",
								className: "dsh-busv-btn",
								onClick: reload,
								title: "重新加载页面（会触发服务端增量 fetch）",
								children: "刷新"
							}),
							jsx.jsx("a", {
								key: "open",
								className: "dsh-busv-btn",
								href: url,
								target: "_blank",
								rel: "noopener noreferrer",
								style: { textDecoration: "none" },
								children: "新窗口"
							}),
							jsx.jsx("span", {
								key: "status",
								className: "dsh-busv-status",
								"data-state": state,
								children:
									state === "down"
										? "未连上 bus-report 服务"
										: state === "probing"
										? "连接中…"
										: "已连接"
							})
						]
					}),
					jsx.jsx("div", {
						key: "body",
						className: "dsh-busv-body",
						children: [
							jsx.jsx("iframe", {
								key: "frame",
								className: "dsh-busv-frame",
								src,
								title: "bus-report",
								referrerPolicy: "no-referrer"
							}),
							state === "down"
								? jsx.jsx("div", {
										key: "tip",
										className: "dsh-busv-tip",
										children: [
											"先起看板服务：",
											jsx.jsx("code", {
												key: "cmd",
												children:
													"bun run bus-report.ts serve --remote <repo> --out ./out --all-generations"
											}),
											" 然后在上面地址栏填它的 URL（默认 " +
												DEFAULT_URL +
												"）。"
										]
								  })
								: null
						]
					})
				]
			});
		}

		/** 注入样式；返回 disposer，插件停用时清理。 */
		function installStyle() {
			if (document.getElementById(STYLE_ID)) return () => {};
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => {
				if (el.parentNode) el.parentNode.removeChild(el);
			};
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(installStyle, "dsh-bus-viewer: styles");
			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID }, BusViewerPanel)
			);
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 40,
						label: () => "Bus 沟通"
					},
					BusViewerIcon
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
