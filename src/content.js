/**
 * rednote-image-upload — 小红书剪贴板图片上传（微信兼容版）
 *
 * 读取系统剪贴板中的图片，注入小红书创作服务平台原有的 file input，
 * 复用平台自身的校验、预览与上传流程。
 *
 * 读取策略（按顺序）：
 *   1. navigator.clipboard.read() —— 常规截图、浏览器内复制的图片。
 *   2. 粘贴桥（隐藏 contenteditable + execCommand("paste")）——
 *      微信 / Finder 复制的图片带有文件引用（public.file-url），
 *      Chrome 会因此对异步剪贴板 API 隐藏 image/png 等类型，
 *      但 paste 事件仍然携带真实文件，此路径与手动 ⌘V 完全一致。
 *   3. 页面 ⌘V（paste 事件捕获）—— 始终可用。
 */
(() => {
  "use strict";

  const VERSION = "0.2.0";
  const LOG_PREFIX = `[rednote-upload v${VERSION}]`;
  const BUTTON_ID = "xhs-clipboard-upload-button";
  const TOAST_ID = "xhs-clipboard-upload-toast";
  const ENHANCED_ATTRIBUTE = "data-xhs-clipboard-enhanced";

  const SURFACE_KIND = Object.freeze({ EDITOR: "editor", INITIAL: "initial" });
  const IMAGE_TYPES = Object.freeze({
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  });

  class UploadError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "UploadError";
      this.code = code;
    }
  }

  function isSupportedImageType(type) {
    return Object.hasOwn(IMAGE_TYPES, (type || "").toLowerCase());
  }

  function normalizeImageType(type) {
    const lower = (type || "").toLowerCase();
    return lower === "image/jpg" ? "image/jpeg" : lower;
  }

  function log(...args) {
    console.info(LOG_PREFIX, ...args);
  }

  /* ------------------------------------------------------------------ *
   * 剪贴板读取
   * ------------------------------------------------------------------ */

  /** 从 paste 事件的 clipboardData 中提取受支持的图片文件。 */
  function extractImageFiles(clipboardData) {
    if (!clipboardData) {
      return [];
    }

    const files = Array.from(clipboardData.files || []).filter((file) =>
      isSupportedImageType(file.type)
    );
    if (files.length > 0) {
      return files;
    }

    return Array.from(clipboardData.items || [])
      .filter((item) => item.kind === "file" && isSupportedImageType(item.type))
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }

  /** 路径 1：异步剪贴板 API。 */
  async function filesFromAsyncClipboard() {
    if (typeof navigator.clipboard?.read !== "function") {
      throw new UploadError("API_UNAVAILABLE", "当前 Chrome 版本不支持读取剪贴板图片");
    }

    const items = await navigator.clipboard.read();
    const timestamp = Date.now();
    const files = [];

    for (const item of items) {
      const type = (item.types || []).find(isSupportedImageType);
      if (!type) {
        continue;
      }
      const blob = await item.getType(type);
      const normalized = normalizeImageType(type);
      files.push(
        new File(
          [blob],
          `clipboard-${timestamp}-${files.length + 1}.${IMAGE_TYPES[normalized]}`,
          { type: normalized, lastModified: timestamp }
        )
      );
    }

    if (files.length === 0) {
      throw new UploadError("NO_IMAGE_TYPE", "剪贴板里没有 PNG、JPG 或 WebP 图片");
    }
    return files;
  }

  /**
   * 路径 2：粘贴桥。
   * 聚焦一个隐藏的 contenteditable 元素并执行 execCommand("paste")，
   * 触发与 ⌘V 相同的 paste 事件，从而拿到微信剪贴板里的真实文件。
   * 需要 clipboardRead 权限与用户手势（按钮点击提供）。
   */
  function filesFromPasteBridge(doc) {
    return new Promise((resolve, reject) => {
      const previousFocus = doc.activeElement;
      const host = doc.createElement("div");
      host.setAttribute("contenteditable", "true");
      host.setAttribute("aria-hidden", "true");
      host.tabIndex = -1;
      host.style.cssText =
        "position:fixed;left:-99999px;top:0;width:1px;height:1px;" +
        "overflow:hidden;opacity:0;pointer-events:none;";
      doc.body.appendChild(host);

      let settled = false;
      let timer = null;

      const finish = (settle, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        host.removeEventListener("paste", onPaste, true);
        host.remove();
        if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
          previousFocus.focus();
        }
        settle(value);
      };

      const onPaste = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const files = extractImageFiles(event.clipboardData);
        if (files.length > 0) {
          finish(resolve, files);
        } else {
          finish(
            reject,
            new UploadError("NO_IMAGE_TYPE", "剪贴板里没有 PNG、JPG 或 WebP 图片")
          );
        }
      };

      timer = setTimeout(() => {
        finish(reject, new UploadError("BRIDGE_TIMEOUT", "读取剪贴板超时，请重新复制后再试"));
      }, 2000);

      host.addEventListener("paste", onPaste, true);
      host.focus();

      let allowed = false;
      try {
        allowed = doc.execCommand("paste");
      } catch {
        allowed = false;
      }
      if (!allowed) {
        finish(
          reject,
          new UploadError("BRIDGE_BLOCKED", "浏览器拦截了程序化粘贴，请直接按 ⌘V 粘贴")
        );
      }
    });
  }

  /** 按钮点击入口：先走异步 API，失败时回退到粘贴桥。 */
  async function readClipboardImageFiles(doc) {
    try {
      const files = await filesFromAsyncClipboard();
      return { files, source: "async-clipboard" };
    } catch (error) {
      const noImageType = error?.code === "NO_IMAGE_TYPE";
      const blockedOrUnfocused =
        error?.name === "NotAllowedError" || error?.name === "SecurityError";
      if (!noImageType && !blockedOrUnfocused) {
        throw error;
      }
      // 微信 / Finder 的剪贴板带文件引用，异步 API 看不到图片类型；
      // 要么窗口失焦导致 read() 被拒。paste 事件路径都可能拿到真实文件。
      log("异步剪贴板 API 未返回图片，尝试粘贴桥（微信图片兼容路径）", {
        reason: error?.code || error?.name
      });
      const files = await filesFromPasteBridge(doc);
      return { files, source: "paste-bridge" };
    }
  }

  function readableError(error) {
    if (error instanceof UploadError) {
      return error.message;
    }
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      return "未获得剪贴板读取权限，请检查扩展权限后刷新页面";
    }
    if (error?.name === "NotFoundError") {
      return "剪贴板里的图片暂时无法读取，请重新复制后再试";
    }
    return "读取剪贴板图片失败，请重新复制后再试";
  }

  /* ------------------------------------------------------------------ *
   * 上传入口识别（小红书页面结构）
   * ------------------------------------------------------------------ */

  function isImageUploadInput(input) {
    if (!input || input.type !== "file" || !input.multiple) {
      return false;
    }
    const accept = (input.accept || "").toLowerCase();
    return accept.includes(".jpg") && accept.includes(".png");
  }

  function findInitialSurface(inputs) {
    for (const input of inputs) {
      const container = input.parentElement;
      if (!container) {
        continue;
      }

      let buttonGroup = container.querySelector(".image-upload-buttons");
      if (!buttonGroup) {
        buttonGroup = Array.from(container.querySelectorAll("div")).find((element) =>
          Array.from(element.children)
            .filter((child) => child.tagName === "BUTTON")
            .some((button) => (button.textContent || "").trim() === "上传图片")
        );
      }

      if (buttonGroup) {
        return { input, kind: SURFACE_KIND.INITIAL, mountTarget: buttonGroup };
      }
    }
    return null;
  }

  function isAtImageLimit(statusText) {
    const match = (statusText || "").trim().match(/^(\d+)\s*\/\s*(\d+)$/);
    return Boolean(match && Number(match[1]) >= Number(match[2]));
  }

  function findEditorSurface(inputs) {
    for (const input of inputs) {
      const imageList = input.closest?.(".img-list");
      if (!imageList) {
        continue;
      }

      const title = imageList.querySelector(".title-area .title");
      if ((title?.textContent || "").trim() !== "图片编辑") {
        continue;
      }

      const status = imageList.querySelector(".title-area .status");
      if (status && isAtImageLimit(status.textContent)) {
        continue;
      }

      const uploadEntry = imageList.querySelector(".img-upload-area .entry");
      if (uploadEntry?.parentElement) {
        return {
          input,
          kind: SURFACE_KIND.EDITOR,
          mountTarget: uploadEntry.parentElement,
          insertBefore: uploadEntry
        };
      }
    }
    return null;
  }

  function isVisible(element) {
    if (!element || element.isConnected === false) {
      return false;
    }
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return element.getClientRects().length > 0;
  }

  function findUploadSurface(doc) {
    const inputs = Array.from(
      doc.querySelectorAll('input[type="file"][multiple]')
    ).filter(isImageUploadInput);

    for (const finder of [findEditorSurface, findInitialSurface]) {
      for (const input of inputs) {
        const surface = finder([input]);
        if (surface && isVisible(surface.mountTarget)) {
          return surface;
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 文件注入：走小红书原有上传流程
   * ------------------------------------------------------------------ */

  function injectFiles(input, files) {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ------------------------------------------------------------------ *
   * 页面 ⌘V 接管
   * ------------------------------------------------------------------ */

  function isEditableTarget(target) {
    if (!target) {
      return false;
    }
    const tagName = (target.tagName || "").toUpperCase();
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tagName) || target.isContentEditable) {
      return true;
    }
    return Boolean(
      target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    );
  }

  function handlePagePaste(event, doc) {
    // 文本编辑区内的粘贴不接管；粘贴桥的隐藏编辑区同样跳过，
    // 由桥自己的监听器处理。
    if (event.defaultPrevented || isEditableTarget(event.target)) {
      return;
    }

    const files = extractImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }

    const surface = findUploadSurface(doc);
    if (!surface) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      injectFiles(surface.input, files);
      showToast(doc, successMessage(files.length));
      log("快捷粘贴图片", { fileCount: files.length, surface: surface.kind });
    } catch (error) {
      showToast(doc, readableError(error), "error");
      log("快捷粘贴失败", { errorName: error?.name, errorCode: error?.code });
    }
  }

  /* ------------------------------------------------------------------ *
   * UI：按钮、提示条
   * ------------------------------------------------------------------ */

  function successMessage(count) {
    return count === 1 ? "已添加剪贴板图片" : `已添加 ${count} 张剪贴板图片`;
  }

  let toastTimer = null;

  function showToast(doc, message, tone = "success") {
    let toast = doc.getElementById(TOAST_ID);
    if (!toast) {
      toast = doc.createElement("div");
      toast.id = TOAST_ID;
      toast.className = "xhs-clipboard-toast";
      toast.setAttribute("aria-live", "polite");
      doc.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    toast.classList.remove("xhs-clipboard-toast-visible");
    void toast.offsetWidth;
    toast.classList.add("xhs-clipboard-toast-visible");

    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      toast.classList.remove("xhs-clipboard-toast-visible");
    }, 3200);
  }

  function createPasteIcon(doc) {
    // 基于 lucide:clipboard-paste（ISC License）的粘贴图标。
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    const attributes = {
      viewBox: "0 0 24 24",
      width: "17",
      height: "17",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    };
    Object.entries(attributes).forEach(([name, value]) => svg.setAttribute(name, value));

    [
      ["path", { d: "M11 14h10" }],
      ["path", { d: "M16 4h2a2 2 0 0 1 2 2v1.344" }],
      ["path", { d: "m17 18 4-4-4-4" }],
      ["path", { d: "M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113" }],
      ["rect", { x: "8", y: "2", width: "8", height: "4", rx: "1" }]
    ].forEach(([tagName, attrs]) => {
      const element = doc.createElementNS("http://www.w3.org/2000/svg", tagName);
      Object.entries(attrs).forEach(([name, value]) => element.setAttribute(name, value));
      svg.appendChild(element);
    });

    return svg;
  }

  function setButtonState(button, state) {
    button.dataset.state = state;
    button.disabled = state === "loading";
    const label = button.querySelector(".xhs-clipboard-button-label");
    if (label) {
      label.textContent = state === "loading" ? "读取中" : "粘贴图片";
    }
  }

  async function handlePasteClick(event, surface, doc) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    if (!button || button.disabled) {
      return;
    }

    setButtonState(button, "loading");
    try {
      const { files, source } = await readClipboardImageFiles(doc);
      injectFiles(surface.input, files);
      setButtonState(button, "success");
      showToast(doc, successMessage(files.length));
      log("读取剪贴板图片", { fileCount: files.length, surface: surface.kind, source });
    } catch (error) {
      setButtonState(button, "error");
      showToast(doc, readableError(error), "error");
      log("粘贴失败", {
        errorName: error?.name || "Error",
        errorCode: error?.code || null,
        surface: surface.kind
      });
    } finally {
      setTimeout(() => {
        if (button.isConnected) {
          setButtonState(button, "idle");
        }
      }, 1200);
    }
  }

  function createPasteButton(doc, surface) {
    const button = doc.createElement("button");
    button.id = BUTTON_ID;
    button.className = `xhs-clipboard-button xhs-clipboard-button--${surface.kind}`;
    button.dataset.surfaceKind = surface.kind;
    button.type = "button";
    button.title = "从系统剪贴板上传图片（支持微信复制的图片）";
    button.setAttribute("aria-label", "从系统剪贴板上传图片");
    button.appendChild(createPasteIcon(doc));

    const label = doc.createElement("span");
    label.className = "xhs-clipboard-button-label";
    label.textContent = "粘贴图片";
    button.appendChild(label);

    button.addEventListener("click", (event) => {
      void handlePasteClick(event, surface, doc);
    });
    return button;
  }

  function mountButton(doc) {
    const existing = doc.getElementById(BUTTON_ID);
    const surface = findUploadSurface(doc);
    if (!surface) {
      existing?.remove();
      return false;
    }

    if (
      existing &&
      existing.dataset.surfaceKind === surface.kind &&
      existing.parentElement === surface.mountTarget
    ) {
      return true;
    }

    existing?.remove();
    surface.mountTarget.setAttribute(ENHANCED_ATTRIBUTE, "true");
    const button = createPasteButton(doc, surface);

    if (surface.kind === SURFACE_KIND.EDITOR) {
      surface.mountTarget.insertBefore(button, surface.insertBefore || null);
    } else {
      const uploadButton = Array.from(surface.mountTarget.children).find(
        (element) =>
          element.tagName === "BUTTON" && (element.textContent || "").trim() === "上传图片"
      );
      if (uploadButton) {
        uploadButton.insertAdjacentElement("afterend", button);
      } else {
        surface.mountTarget.appendChild(button);
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function boot(doc) {
    log("插件已启动", { url: location.href });

    let mountQueued = false;
    const queueMount = () => {
      if (mountQueued) {
        return;
      }
      mountQueued = true;
      requestAnimationFrame(() => {
        mountQueued = false;
        mountButton(doc);
      });
    };

    mountButton(doc);
    doc.addEventListener("paste", (event) => handlePagePaste(event, doc), true);

    const observer = new MutationObserver(queueMount);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    boot(document);
  }
})();