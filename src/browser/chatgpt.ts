import type { Page, Locator } from "patchright";
import { joinSelectors } from "./selectors.js";
import { SelectorBrokenError } from "../errors.js";

export const CHATGPT_HOME = "https://chatgpt.com/";

export async function goHome(page: Page, opts: { model?: string } = {}): Promise<void> {
  const url = new URL(CHATGPT_HOME);
  if (opts.model) {
    url.searchParams.set("model", opts.model);
  }
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });

  // April 2026: chatgpt.com shows a "Welcome back — Choose an account
  // to continue" modal when the NextAuth session is stale. Closing it
  // (X) drops into anonymous trial mode where the model picker and
  // web search are locked. Only `cgpro login` (which runs headed with
  // the user present) can handle this by clicking the account card
  // and completing the Google OAuth redirect.
  //
  // For non-login commands: detect the modal and throw so the caller
  // gets a clean "run cgpro login" error instead of silently degrading.
  const welcomeBack = await detectWelcomeBackModal(page);
  if (welcomeBack) {
    throw new (await import("../errors.js")).CgproError(
      "ChatGPT session expired — the page is showing a re-authentication modal.",
      2,
      "Run `cgpro login` to refresh the session (browser opens, you pick your account, Google OAuth completes, then all other commands work again).",
    );
  }
}

/**
 * Returns true if the "Welcome back — Choose an account" modal is visible.
 */
export async function detectWelcomeBackModal(page: Page): Promise<boolean> {
  await page.waitForTimeout(2_000);
  const modal = await firstResolved(page, [
    '[data-testid="log-back-form"]',
    '[data-testid="modal-no-auth-login"]',
  ]);
  return !!modal;
}

/**
 * If the "Welcome back — Choose an account" modal is showing, click the
 * first account card and wait for the OAuth redirect to complete.
 *
 * Flow observed April 2026:
 *   chatgpt.com → "Welcome back" modal → click account →
 *   accounts.google.com OAuth → redirect back to chatgpt.com
 *
 * The whole redirect chain can take 5-15s depending on Google's
 * consent page. We wait up to 60s for the URL to land back on
 * chatgpt.com. If the user is in interactive mode (cgpro login),
 * they may need to complete 2FA during this window.
 */
// dismissWelcomeBackModal removed — closing the modal drops the page
// into anonymous trial mode (model picker locked, web search gone).
// The Welcome back flow MUST complete via Google OAuth, which is
// interactive. Only cgpro login handles it; all other commands throw.

/**
 * Returns true ONLY if `/api/auth/session` returns a real user.
 *
 * Critical detail: `/backend-api/me` is NOT a reliable auth check —
 * it returns the anonymous device id (`ua-XXX`) when called WITHOUT
 * the `Authorization: Bearer <accessToken>` header, even for fully
 * authenticated sessions. `/api/auth/session` uses the NextAuth
 * session cookie directly and returns `{ user: { id: "user-XXX",
 * email, name, ... }, accessToken, expires }`.
 *
 * Earlier versions of cgpro called `/backend-api/me` cookie-only and
 * misinterpreted the resulting `ua-XXX` as "anonymous", silently
 * rejecting valid sessions. Confirmed by check-cookies probe on
 * 2026-04-25.
 */
export async function isLoggedIn(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (!url.includes("chatgpt.com")) {
      await page.waitForTimeout(750);
      continue;
    }
    // Reject "Welcome back" modal and anonymous trial mode.
    const modal = await firstResolved(page, [
      '[data-testid="log-back-form"]',
      '[data-testid="modal-no-auth-login"]',
    ]);
    if (modal) {
      await page.waitForTimeout(750);
      continue;
    }
    const loginBtn = await firstResolved(page, [
      '[data-testid="login-button"]',
    ]);
    if (loginBtn) {
      // Anonymous trial mode — not authenticated.
      await page.waitForTimeout(750);
      continue;
    }
    const session = await fetchAuthSessionInPage(page);
    if (session?.user?.id?.startsWith("user-")) {
      return true;
    }
    await page.waitForTimeout(750);
  }
  return false;
}

/**
 * Calls `/api/auth/session` from inside the page context (cookies are
 * sent by the browser; no Bearer needed for this endpoint).
 * Returns the full session including the accessToken — caller can use
 * the token to authorize subsequent `/backend-api/*` calls.
 */
export interface AuthSessionFull {
  user?: {
    id?: string;
    name?: string;
    email?: string;
    image?: string;
    picture?: string;
    idp?: string;
    mfa?: boolean;
  };
  accessToken?: string;
  expires?: string;
  account?: unknown;
  authProvider?: string;
  sessionToken?: string;
}

export async function fetchAuthSessionInPage(page: Page): Promise<AuthSessionFull | null> {
  try {
    const result = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/auth/session", {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        if (!r.ok) return null;
        return (await r.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    return (result ?? null) as AuthSessionFull | null;
  } catch {
    return null;
  }
}

/**
 * Get a valid Bearer accessToken for /backend-api/* calls.
 * Returns null if the user isn't authenticated.
 */
export async function getAccessToken(page: Page): Promise<string | null> {
  const session = await fetchAuthSessionInPage(page);
  return session?.accessToken ?? null;
}

/**
 * Authenticated GET / POST / PATCH / etc. against /backend-api/*.
 * Pulls the accessToken from /api/auth/session and adds the Bearer
 * header automatically. Returns the parsed response body or throws.
 */
export async function backendApiFetch(
  page: Page,
  pathOrUrl: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const token = await getAccessToken(page);
  if (!token) return { ok: false, status: 401, body: null };
  return await page.evaluate(
    async ({ url, method, body, headers, accessToken }) => {
      const r = await fetch(url, {
        method,
        credentials: "include",
        headers: {
          Accept: "application/json",
          "OAI-Language": "en-US",
          Authorization: `Bearer ${accessToken}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(headers ?? {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let parsed: unknown = null;
      try {
        parsed = await r.json();
      } catch {
        parsed = null;
      }
      return { ok: r.ok, status: r.status, body: parsed };
    },
    {
      url: pathOrUrl,
      method: init.method ?? "GET",
      body: init.body,
      headers: init.headers,
      accessToken: token,
    },
  );
}

/**
 * Fetches /backend-api/me with the Bearer JWT pulled from
 * /api/auth/session. Returns null if not signed in.
 */
export async function fetchMeInPage(page: Page): Promise<{
  id?: string;
  email?: string;
  name?: string;
  plan?: string;
  features?: string[];
  orgs?: { data?: Array<{ id?: string; title?: string; settings?: Record<string, unknown> }> };
} | null> {
  const r = await backendApiFetch(page, "/backend-api/me");
  return r.ok ? (r.body as never) : null;
}

/**
 * Try each candidate selector until one resolves to ≥1 visible element.
 * Returns the matching Locator or null.
 */
export async function firstResolved(page: Page, candidates: string[]): Promise<Locator | null> {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      const count = await loc.count();
      if (count > 0) {
        return loc;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export async function requireSelector(
  page: Page,
  candidates: string[],
  name: string,
  timeoutMs = 15_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loc = await firstResolved(page, candidates);
    if (loc) return loc;
    await page.waitForTimeout(250);
  }
  throw new SelectorBrokenError(name);
}

/**
 * Detect a real Cloudflare interstitial (the user-visible "Just a moment"
 * page with no app content). Used by `cgpro doctor` and as a fallback
 * heuristic — NOT in the goHome critical path, since the legitimate
 * chatgpt.com page also embeds Cloudflare beacon scripts.
 */
export async function detectBotChallenge(page: Page): Promise<boolean> {
  const html = await page.content().catch(() => "");
  // Real interstitial: page body shows challenge UI AND no composer / no
  // login form (i.e. nothing of the actual app rendered).
  const hasInterstitialUi =
    html.includes("Just a moment") ||
    html.includes("Verify you are human") ||
    html.includes("checking your browser");
  if (!hasInterstitialUi) return false;
  const composer = await firstResolved(page, [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
  ]);
  const loginLink = await firstResolved(page, [
    'a[href*="login"]',
    'input[type="email"]',
  ]);
  return !composer && !loginLink;
}

/**
 * Backwards-compat thin wrapper around `fetchAuthSessionInPage`. Old
 * code paths used `page.context().request.get` which strips the
 * NextAuth CSRF context and returns a banner-only payload — re-routed
 * through page.evaluate(fetch) so the Bearer/cookies match what the
 * React app sees.
 */
export interface AuthSession {
  user?: { email?: string; name?: string; image?: string };
  expires?: string;
  accessToken?: string;
}

export async function fetchAuthSession(page: Page): Promise<AuthSession | null> {
  const full = await fetchAuthSessionInPage(page);
  if (!full || !full.user || !full.user.email) return null;
  return {
    user: { email: full.user.email, name: full.user.name, image: full.user.image },
    expires: full.expires,
    accessToken: full.accessToken,
  };
}

const joinSelectorsLocal = joinSelectors;
export { joinSelectorsLocal as joinSelectors };
