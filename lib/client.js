// 浏览器半边：在会话顶部工具栏放一个“工作区”按钮，点开插件面板。
// 只依赖宿主内置的 react 和 slots 服务，不引入额外包。

window.__ModuleLoader__.load({
  id: "dsh-hybrid-workspace-v2",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var buttonStyle = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "0 0 auto",
      alignSelf: "center",
      boxSizing: "border-box",
      height: "24px",
      minHeight: "24px",
      maxHeight: "24px",
      width: "auto",
      minWidth: "0",
      padding: "0 8px",
      border: "1px solid var(--dsw-alias-border-l2, #d0d0d0)",
      borderRadius: "6px",
      background: "var(--dsw-alias-bg-layer-1, transparent)",
      color: "var(--dsw-alias-label-secondary, #666)",
      font: "inherit",
      fontSize: "11px",
      lineHeight: "1",
      cursor: "pointer",
      whiteSpace: "nowrap"
    };

    function panelHref() {
      // DSH 桌面端主窗口运行在 dsh-app://app/ 自定义协议下，origin 可能是
      // "null" 或非标准值；用当前完整地址作 base，避免 new URL 直接抛错。
      try {
        return new URL("hybrid-workspace/", window.location.href).href;
      } catch (error) {
        return "/hybrid-workspace/";
      }
    }

    function hostHttpBase() {
      var transport = globalThis.__DSH_TRANSPORT__;
      var base = transport && transport.streamBaseUrl;
      return typeof base === "string" ? base.replace(/\/+$/, "") : "";
    }

    function showPanelOverlay(href) {
      var old = document.getElementById("hybrid-workspace-overlay");
      if (old) old.remove();
      var overlay = document.createElement("div");
      overlay.id = "hybrid-workspace-overlay";
      overlay.setAttribute("style", [
        "position:fixed", "inset:0", "z-index:2147483000",
        "display:flex", "flex-direction:column",
        "background:#0b0e14", "color:#c9d1d9"
      ].join(";"));
      // DSH 桌面窗口使用 hiddenInset 标题栏，面板覆盖整个窗口后必须自己
      // 提供可拖拽区域，否则顶部没有任何地方能拖动窗口。macOS 左侧还要
      // 给红绿灯留出位置，否则标题会压在窗口按钮下面。
      var isMac = /Mac/.test(navigator.platform || "");
      var bar = document.createElement("div");
      bar.setAttribute("data-window-drag", "");
      bar.setAttribute("style", [
        "display:flex", "align-items:center", "justify-content:space-between",
        "box-sizing:border-box", "height:40px", "flex:0 0 40px",
        "padding:" + (isMac ? "0 8px 0 78px" : "0 8px 0 12px"),
        "-webkit-app-region:drag", "app-region:drag", "user-select:none",
        "border-bottom:1px solid #263041", "background:#111827",
        "font:12px/1.2 system-ui,-apple-system,sans-serif"
      ].join(";"));
      var title = document.createElement("span");
      title.textContent = "混合工作区 · 管理";
      var actions = document.createElement("span");
      actions.setAttribute("style", "display:flex;align-items:center;gap:8px;-webkit-app-region:no-drag;app-region:no-drag");
      var externalBase = hostHttpBase();
      if (externalBase) {
        var external = document.createElement("a");
        external.href = externalBase + "/hybrid-workspace/";
        external.target = "_blank";
        external.rel = "noreferrer";
        external.textContent = "浏览器打开";
        external.setAttribute("style", "color:#8fb8ea;text-decoration:none;font-size:12px;-webkit-app-region:no-drag;app-region:no-drag");
        actions.appendChild(external);
      }
      var close = document.createElement("button");
      close.type = "button";
      close.textContent = "关闭";
      close.setAttribute("style", [
        "height:24px", "padding:0 10px", "border:1px solid #3b4a63",
        "border-radius:6px", "background:#1b2433", "color:#d7e0ee",
        "font:inherit", "cursor:pointer", "-webkit-app-region:no-drag", "app-region:no-drag"
      ].join(";"));
      close.addEventListener("click", function () { overlay.remove(); });
      actions.appendChild(close);
      bar.appendChild(title);
      bar.appendChild(actions);
      var frame = document.createElement("iframe");
      frame.src = href;
      frame.title = "混合工作区管理面板";
      frame.setAttribute("style", "flex:1;width:100%;border:0;background:#0b0e14");
      overlay.appendChild(bar);
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
    }

    function OpenPanelButton() {
      return React.createElement("button", {
        type: "button",
        title: "打开混合工作区管理面板",
        "aria-label": "打开混合工作区管理面板",
        style: buttonStyle,
        onClick: function () {
          var href = panelHref();
          // 不离开 DSH 主窗口：dsh-app 自定义协议下顶层导航并不可靠，window.open
          // 又会落到没有登录态的系统浏览器。这里直接在窗口内铺一个全屏 iframe，
          // 页面和 API 仍走 dsh-app://app 的同源转发。
          if (document.body) {
            showPanelOverlay(href);
            return;
          }
          try {
            window.location.assign(href);
          } catch (error) {
            // 没有 body 时只能交给宿主导航；失败就保持原页面，不伪造成功。
          }
        }
      }, "工作区");
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "hybrid-workspace-open",
          order: 90
        }, OpenPanelButton);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
