/**
 * Comprehensive DOM probe: dumps the page structure of chatgpt.com
 * to discover the current selectors after a UI rewrite.
 *
 *   npx tsx scripts/probe-dom.ts
 *
 * Navigates to chatgpt.com, waits for hydration, then snapshots:
 *   - Composer area (input + buttons)
 *   - Sidebar navigation (conversations, projects)
 *   - Account menu / profile
 *   - Page-level structure (main, article, roles)
 */
import { openSession } from "../src/browser/session.js";
import { getAccessToken } from "../src/browser/chatgpt.js";

async function main(): Promise<void> {
  const session = await openSession({ headed: true, background: true });
  try {
    await session.page.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await session.page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);

    const tok = await getAccessToken(session.page);
    console.log(`auth: ${tok ? "OK (Bearer present)" : "ANONYMOUS"}`);

    // Wait for React hydration — a contenteditable or textarea
    await session.page
      .waitForSelector(
        'div[contenteditable="true"], textarea, #prompt-textarea',
        { timeout: 10_000 },
      )
      .catch(() => console.log("(no composer selector found within 10s)"));

    const snapshot = await session.page.evaluate(() => {
      const describe = (el: Element): Record<string, unknown> => {
        const e: Record<string, unknown> = { tag: el.tagName.toLowerCase() };
        if (el.id) e.id = el.id;
        const cls = el.className;
        if (typeof cls === "string" && cls.length > 0 && cls.length < 200) e.cls = cls;
        const testid = el.getAttribute("data-testid");
        if (testid) e.testid = testid;
        const role = el.getAttribute("role");
        if (role) e.role = role;
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) e.ariaLabel = ariaLabel;
        const ah = el.getAttribute("aria-haspopup");
        if (ah) e.ariaHaspopup = ah;
        const ap = el.getAttribute("aria-pressed");
        if (ap) e.ariaPressed = ap;
        const ac = el.getAttribute("aria-checked");
        if (ac) e.ariaChecked = ac;
        const ce = el.getAttribute("contenteditable");
        if (ce) e.contenteditable = ce;
        const tp = el.getAttribute("type");
        if (tp) e.type = tp;
        const href = el.getAttribute("href");
        if (href) e.href = href;
        const txt = (el as HTMLElement).innerText?.trim().slice(0, 80);
        if (txt) e.text = txt;
        // Collect all data-* attrs
        const d: { [k: string]: string } = {};
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith("data-") && attr.name !== "data-testid") {
            d[attr.name] = attr.value.slice(0, 60);
          }
        }
        if (Object.keys(d).length > 0) e.dataAttrs = d;
        return e;
      };

      // 1. ALL buttons on the page
      const buttons = Array.from(document.querySelectorAll("button")).map(describe);

      // 2. ALL elements with role attributes
      const roles = Array.from(
        document.querySelectorAll("[role]"),
      )
        .map(describe)
        .filter((e) => e.role !== "presentation" && e.role !== "none");

      // 3. ALL elements with data-testid
      const testids = Array.from(
        document.querySelectorAll("[data-testid]"),
      ).map(describe);

      // 4. ALL elements with data-message-* attrs
      const dataMessage = Array.from(
        document.querySelectorAll("[data-message-author-role], [data-message-id], [data-message-content]"),
      ).map(describe);

      // 5. Contenteditable elements (composer candidates)
      const editables = Array.from(
        document.querySelectorAll('[contenteditable="true"]'),
      ).map(describe);

      // 6. Article / main / section structure
      const structure = Array.from(
        document.querySelectorAll("main, article, section, nav, header, footer"),
      ).map(describe);

      // 7. Links in the sidebar (conversation items)
      const sidebarLinks = Array.from(
        document.querySelectorAll('nav a[href^="/c/"], a[href^="/c/"]'),
      ).map(describe);

      // 8. Input[type=file] (upload)
      const fileInputs = Array.from(
        document.querySelectorAll('input[type="file"]'),
      ).map(describe);

      // 9. Markdown containers
      const markdownContainers = Array.from(
        document.querySelectorAll("div.markdown, .prose, [class*='markdown']"),
      ).map(describe);

      return {
        url: window.location.href,
        title: document.title,
        buttons: buttons.length,
        roles: roles.length,
        testids: testids.length,
        dataMessage: dataMessage.length,
        editables: editables.length,
        structure: structure.length,
        sidebarLinks: sidebarLinks.length,
        fileInputs: fileInputs.length,
        markdownContainers: markdownContainers.length,
        detail: {
          buttons: buttons.slice(0, 50),
          roles: roles.slice(0, 50),
          testids,
          dataMessage,
          editables,
          structure: structure.slice(0, 30),
          sidebarLinks: sidebarLinks.slice(0, 20),
          fileInputs,
          markdownContainers,
        },
      };
    });

    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await session.close();
  }
}

void main();
