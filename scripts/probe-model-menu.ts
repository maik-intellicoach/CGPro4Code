import { openSession } from "../src/browser/session.js";
import { goHome, getAccessToken, firstResolved } from "../src/browser/chatgpt.js";
import { SELECTORS } from "../src/browser/selectors.js";

async function main() {
  const s = await openSession({ headed: true, background: true });
  try {
    await goHome(s.page);
    const tok = await getAccessToken(s.page);
    if (!tok) { console.error("ANON"); process.exit(2); }

    // Click the model switcher to open the menu
    const trigger = await firstResolved(s.page, SELECTORS.modelSwitcher);
    if (!trigger) { console.error("model switcher not found"); process.exit(3); }
    console.log("model switcher text:", await trigger.textContent());

    // Snapshot DOM element count before click
    const beforeCount = await s.page.evaluate(() => document.querySelectorAll("*").length);

    await trigger.click({ timeout: 5_000 });
    await s.page.waitForTimeout(2_000);

    const afterCount = await s.page.evaluate(() => document.querySelectorAll("*").length);
    console.log(`DOM elements: ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})`);

    // Dump ANY new popover / dialog / dropdown that appeared
    const items = await s.page.evaluate(() => {
      // Look at everything: popovers, dialogs, popover containers, fixed/absolute positioned
      const all = Array.from(document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], ' +
        '[data-state="open"], [class*="popover"], [class*="dropdown"], [class*="modal"], ' +
        '[role="menuitem"], [role="menuitemradio"], [role="option"]'
      )).map((e) => ({
        tag: e.tagName,
        role: e.getAttribute("role"),
        tid: e.getAttribute("data-testid"),
        state: e.getAttribute("data-state"),
        cls: (e.className || "").toString().slice(0, 80),
        txt: ((e as HTMLElement).innerText || "").trim().slice(0, 120),
        childCount: e.children.length,
      }));
      return all;
    });
    console.log("=== everything after model-switcher click ===");
    console.log(JSON.stringify(items, null, 2));

    await s.page.keyboard.press("Escape");
  } finally {
    await s.close();
  }
}

void main();
