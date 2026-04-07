import type { DomContext } from "./types";

const NEVER_CAPTURE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete*="cc-"]',
  '[data-sensitive]',
  '.cc-number',
  '[aria-label*="password" i]',
];

function isSensitive(el: Element): boolean {
  return NEVER_CAPTURE_SELECTORS.some((sel) => {
    try { return el.matches(sel); } catch { return false; }
  });
}

function getDomain(): string {
  return window.location.hostname;
}

function getContext(el: Element): DomContext {
  const tag = el.tagName.toLowerCase();
  let text = "";
  if (el instanceof HTMLAnchorElement || el instanceof HTMLButtonElement || el instanceof HTMLElement) {
    text = (el as HTMLElement).innerText?.trim().slice(0, 100) ?? "";
  }
  return {
    element_type: tag,
    element_text: text,
    element_id: (el as HTMLElement).id || null,
    visible_text_nearby: el.parentElement
      ? ((el.parentElement as HTMLElement).innerText ?? "").trim().slice(0, 150).replace(/\s+/g, " ")
      : "",
  };
}

function sendEvent(partial: Omit<import("./types").CapturedEvent, "sequence_number">): void {
  chrome.runtime.sendMessage({ type: "CAPTURED_EVENT", event: partial }).catch(() => { /* sw sleeping */ });
}

// ── Click ────────────────────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  const target = e.target as Element;
  if (!target || isSensitive(target)) return;
  sendEvent({
    event_type: "click",
    url: window.location.href,
    domain: getDomain(),
    dom_context: getContext(target),
    screenshot_b64: null,
    timestamp: Date.now(),
  });
}, { capture: true, passive: true });

// ── Navigation (SPA) ─────────────────────────────────────────────────────────

let lastUrl = window.location.href;
new MutationObserver(() => {
  const cur = window.location.href;
  if (cur !== lastUrl) {
    sendEvent({
      event_type: "navigation",
      url: cur,
      domain: getDomain(),
      dom_context: { element_type: "url", element_text: cur, element_id: null, visible_text_nearby: "" },
      screenshot_b64: null,
      timestamp: Date.now(),
    });
    lastUrl = cur;
  }
}).observe(document.body, { subtree: true, childList: true });

// ── Form submit ───────────────────────────────────────────────────────────────

document.addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  const fieldKeys = Array.from(form.elements)
    .filter((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    .map((el) => (el as HTMLInputElement).name || (el as HTMLInputElement).id)
    .filter(Boolean)
    .join(", ")
    .slice(0, 150);
  sendEvent({
    event_type: "form_submit",
    url: window.location.href,
    domain: getDomain(),
    dom_context: { element_type: "form", element_text: form.id || "", element_id: form.id || null, visible_text_nearby: fieldKeys },
    screenshot_b64: null,
    timestamp: Date.now(),
  });
}, { capture: true, passive: true });

// ── Copy (length only, no content) ───────────────────────────────────────────

document.addEventListener("copy", () => {
  const len = window.getSelection()?.toString().length ?? 0;
  sendEvent({
    event_type: "copy_text",
    url: window.location.href,
    domain: getDomain(),
    dom_context: { element_type: "selection", element_text: "", element_id: null, visible_text_nearby: `${len} chars copied` },
    screenshot_b64: null,
    timestamp: Date.now(),
  });
});

// Mark presence so the web app can detect the extension
document.documentElement.dataset.percent99Observer = "active";

console.log("[99percent] Content script loaded on", getDomain());
