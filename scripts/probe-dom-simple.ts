import { openSession } from "../src/browser/session.js";
import { getAccessToken, goHome } from "../src/browser/chatgpt.js";

async function main() {
  console.error("starting...");
  const s = await openSession({ headed: true, background: true });
  try {
    console.error("goHome (handles welcome-back modal)...");
    await goHome(s.page);
    await s.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await s.page.waitForTimeout(3_000);

    console.error("getting token...");
    const tok = await getAccessToken(s.page);
    console.log("AUTH=" + (tok ? "OK" : "ANON"));

    console.error("evaluating DOM...");
    const info = await s.page.evaluate(() => {
      return {
        url: location.href,
        title: document.title,
        bodyLen: document.body?.innerHTML?.length ?? 0,
        testids: Array.from(document.querySelectorAll("[data-testid]")).map(
          (e) => e.getAttribute("data-testid"),
        ),
        editables: Array.from(
          document.querySelectorAll("[contenteditable]"),
        ).map((e) => ({
          tag: e.tagName,
          id: e.id || undefined,
          ce: e.getAttribute("contenteditable"),
        })),
        buttons: Array.from(document.querySelectorAll("button"))
          .slice(0, 40)
          .map((e) => ({
            tid: e.getAttribute("data-testid") || undefined,
            al: e.getAttribute("aria-label") || undefined,
            txt: (e.innerText || "").trim().slice(0, 50) || undefined,
          }))
          .filter((b) => b.tid || b.al || b.txt),
        navLinks: Array.from(document.querySelectorAll('a[href*="/c/"]'))
          .slice(0, 10)
          .map((e) => ({
            href: e.getAttribute("href"),
            tid: e.getAttribute("data-testid") || undefined,
            txt: (e.textContent || "").trim().slice(0, 40),
          })),
        dataMsgCount: document.querySelectorAll("[data-message-author-role]").length,
        markdownCount: document.querySelectorAll("div.markdown, .prose").length,
        articles: document.querySelectorAll("article").length,
        // New: look for any data-* attrs that might identify messages
        dataMsgIds: Array.from(document.querySelectorAll("[data-message-id]")).length,
        dataTurns: Array.from(
          document.querySelectorAll('[data-testid*="turn"], [data-testid*="message"]'),
        )
          .slice(0, 10)
          .map((e) => ({
            tag: e.tagName,
            tid: e.getAttribute("data-testid"),
          })),
      };
    });
    console.log(JSON.stringify(info, null, 2));

    console.error("taking screenshot...");
    await s.page.screenshot({
      path: "C:/Code/CGPro4Code/debug-screenshot-2.png",
      fullPage: false,
    });
    console.log("SCREENSHOT=debug-screenshot-2.png");
  } catch (err) {
    console.error("ERROR:", (err as Error).message);
  } finally {
    await s.close();
  }
}

void main();
