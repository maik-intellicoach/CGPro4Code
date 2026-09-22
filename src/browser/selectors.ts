/**
 * All ChatGPT.com DOM selectors live here. When OpenAI ships a UI change,
 * patch this file. Each entry has a primary selector + ordered fallbacks.
 *
 * Verified against chatgpt.com as of July 21, 2026 (C-092 drift: the
 * "Work" area rollout moved the model picker out of the header into an
 * inline composer pill and added a Chat/Work surface toggle).
 */

export interface SelectorSet {
  /** Composer textarea (#prompt-textarea is a stable ID since at least 2024). */
  composer: string[];
  /** Send/submit button next to the composer. */
  sendButton: string[];
  /** Stop-streaming button (visible only while the model is producing tokens). */
  stopButton: string[];
  /** Model picker / dropdown trigger (composer-inline pill since the C-092 Work-area rollout). */
  modelSwitcher: string[];
  thinkingPowerButton: string[];
  selectedPowerModel: string[];
  thinkingPowerSlider: string[];
  projectsNavigation: string[];
  projectRows: string[];
  /** "Chat" surface radio in the Chat/Work toggle (Work-area rollout, C-092). */
  chatTabRadio: string[];
  /** Web search composer toggle. */
  webSearchToggle: string[];
  /** Native ChatGPT Deep Research composer mode. */
  deepResearchToggle: string[];
  /** Selected native Deep Research chip in the composer. */
  deepResearchSelected: string[];
  /** Account / profile button — proxy for "logged in" state. */
  accountMenu: string[];
  /** All assistant message bubbles in the current conversation. */
  assistantMessages: string[];
  /** All message bubbles (any role) in the current conversation. */
  anyMessages: string[];
  /** Action bar (copy / regenerate / good / bad) shown on a completed assistant response. */
  assistantActionBar: string[];
  /** Markdown-rendered body inside an assistant bubble. */
  assistantMarkdown: string[];
  /** Conversation history list in the sidebar. */
  conversationList: string[];
  /** Individual conversation item in the sidebar. */
  conversationItem: string[];
  /** New chat / fresh conversation trigger. */
  newChatButton: string[];
  /** File upload input (hidden, used via setInputFiles). */
  fileUpload: string[];
  /**
   * Full-screen overlays that intercept pointer events without exposing any
   * role `OPEN_MENU_SELECTOR` matches.
   *
   * P-035 2026-09-22. Playwright named this one itself, verbatim, on the
   * Projects-navigation failure that killed the turn:
   *   `<div data-state="open" class="fixed inset-0 z-50 …dark:before:bg-black/50…">`
   *   from `<div id="modal-beacon" data-testid="modal-beacon"
   *         data-ignore-for-page-load="true">`
   * The host carries an id and a testid and NO role, so the closure proof in
   * `closeOpenMenus` counted zero open overlays while the sidebar was
   * unreachable, and the click helper retried the same blocked click three
   * times. Deliberately NOT in TURN_CRITICAL_SELECTORS: absence is the healthy
   * state, and that audit only fails on absence.
   */
  blockingOverlay: string[];
}

export const SELECTORS: SelectorSet = {
  composer: [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Envoyer"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    // Current ChatGPT composer no longer exposes the older stable attributes
    // on every account surface. Keep this deliberately broad fallback last.
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button:has(svg[data-testid="send-button"])',
    'button[aria-label*="Send"]',
    'button[aria-label*="Envoyer"]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[data-testid="composer-submit-button"]:has(svg rect)',
    'form button:has(svg rect)',
    'main button:has(svg rect)',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Arrêter"]',
    'button:has-text("Stop generating")',
  ],
  modelSwitcher: [
    'button.__composer-pill[aria-haspopup="menu"]',
    'button[data-testid="model-switcher-dropdown-button"]',
    'header button[aria-label*="Model selector"]',
    'header button[aria-label*="Sélecteur"]',
    'button[aria-haspopup="menu"]:has(svg)',
  ],
    // Working candidate first (P-035 2026-09-16): every lane probed had this
    // entry matching and the ones after it dead, so the daemon paid a failed
    // probe per turn. Kept as tail fallbacks in case the attributes return.
  thinkingPowerButton: [
    // P-035 2026-09-21: the structural composer pill, FIRST. A no-submit
    // preflight on a lane that failed here reported this selector resolving
    // (1 attached, visible) while all three label candidates below matched
    // ZERO elements, attached or visible -- the pill exists and its label is
    // simply not one of the strings the next entries enumerate. Matching by
    // structure is the same strategy `modelSwitcher` already relies on, and
    // correctness is unchanged: the gate still refuses unless the menu opens,
    // the slider reaches aria-valuemax, and the menu reads 6 Pro.
    'button.__composer-pill[aria-haspopup="menu"]',
    'button:has(:text-matches("^(?:6\\\\s*Pro|High|Instant)$", "i"))',
    'button:has-text("Thinking effort")',
    'button:text-matches("^(?:6\\\\s*Pro|High|Instant)$", "i")',
  ],
  selectedPowerModel: ['[role="menuitem"][aria-label="Select model"]'],
  thinkingPowerSlider: ['[role="slider"][aria-valuemax]'],
  projectsNavigation: ['a[href="/projects"]'],
  projectRows: ['[role="row"]'],
  chatTabRadio: [
    'button[role="radio"]:has-text("Chat")',
    'div[role="radiogroup"] button:has-text("Chat")',
  ],
  webSearchToggle: [
    // Current chatgpt.com (April 2026): web search is a menuitemradio
    // inside the "+ Add files and more" composer popover. Has no
    // aria-label, no data-testid — only the inner text.
    '[role="menuitemradio"]:has-text("Web search")',
    '[role="menuitemradio"]:has-text("Recherche web")',
    'div[role="menuitemradio"]:has-text("Web")',
    // Older inline-toggle layouts (kept as fallback)
    'button[data-testid="composer-tool-web-search"]',
    'button[aria-label*="Search the web"]',
    'button[aria-label*="Rechercher sur le web"]',
    'button[aria-label*="web search" i]',
  ],
  deepResearchToggle: [
    'div.__menu-item[tabindex="0"]:has(span:text-is("Deep research"))',
    'div.__menu-item[tabindex="0"]:has(span:text-is("Recherche approfondie"))',
    '[data-radix-popper-content-wrapper] [role="menuitemradio"]:has-text("Deep research")',
    '[data-radix-popper-content-wrapper] [role="menuitemradio"]:has-text("Recherche approfondie")',
    '[data-radix-popper-content-wrapper] button[data-testid="composer-tool-deep-research"]',
    '[data-radix-popper-content-wrapper] button[aria-label*="Deep research" i]',
    '[data-radix-popper-content-wrapper] span:text-is("Deep research")',
  ],
  deepResearchSelected: [
    '#prompt-textarea [data-inline-selection-pill][data-id="plugin:connector_openai_deep_research"]',
    'form [data-testid*="deep-research" i]',
    'form button:text-is("Deep research")',
  ],
  accountMenu: [
    'button[data-testid="profile-button"]',
    'button[data-testid="user-menu-button"]',
    'header img[alt*="user"]',
    'nav button:has(img[alt])',
  ],
  assistantMessages: [
    'div[data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"]',
    'main article:has([data-message-author-role="assistant"])',
  ],
  anyMessages: [
    "div[data-message-author-role]",
    "[data-message-author-role]",
    'div[data-testid^="conversation-turn"]',
    "main article",
  ],
  assistantActionBar: [
    'div[role="group"][aria-label*="Actions sur la"]',
    'div[role="group"][aria-label*="Actions on"]',
    'div[role="group"][aria-label*="Actions"]',
  ],
  assistantMarkdown: [
    "div.markdown",
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
  ],
    // Working candidate first (P-035 2026-09-16): every lane probed had this
    // entry matching and the ones after it dead, so the daemon paid a failed
    // probe per turn. Kept as tail fallbacks in case the attributes return.
  conversationList: [
    'nav[aria-label="Chat history"]',
    'nav[aria-label*="historique" i]',
    '[data-testid="conversation-list"]',
  ],
  conversationItem: [
    '[data-testid^="history-item-"]',
    '[data-testid="conversation-item"]',
    'nav a[href^="/c/"]',
  ],
    // Working candidate first (P-035 2026-09-16): every lane probed had this
    // entry matching and the ones after it dead, so the daemon paid a failed
    // probe per turn. Kept as tail fallbacks in case the attributes return.
  newChatButton: [
    'a[href="/"]:has(svg)',
    'button[data-testid="create-new-chat-button"]',
    'button[data-testid="new-chat-button"]',
  ],
    // Working candidate first (P-035 2026-09-16): every lane probed had this
    // entry matching and the ones after it dead, so the daemon paid a failed
    // probe per turn. Kept as tail fallbacks in case the attributes return.
  fileUpload: [
    'input[type="file"]',
    'input[type="file"][data-testid="file-upload"]',
    'input[type="file"][data-testid="file-upload-button"]',
  ],
  blockingOverlay: [
    '[data-testid="modal-beacon"] [data-state="open"]',
    '#modal-beacon [data-state="open"]',
  ],
};

/**
 * Selectors a turn cannot start without, and which therefore must resolve on
 * any authenticated page (P-035 2026-09-16).
 *
 * The read-only selector audit (`GET /selectors`, `cgpro doctor --via-daemon`)
 * deliberately counts what is attached, so it cannot tell a stale selector from
 * a surface that is simply not open: on a healthy lane 12 of 22 keys resolve to
 * nothing because the conversation, the tools popover or the Projects directory
 * is not mounted. Only absence of a key listed here is UNRESOLVED -- a word
 * chosen deliberately over "drift", because the audit counts attachment and
 * cannot tell a stale selector from a state that is not mounted yet (P-035
 * 2026-09-21). Surface-scoped keys (`projectRows`, `deepResearchToggle`,
 * `assistantMessages`, ...) are reported but never fail the audit.
 *
 * `thinkingPowerButton` belongs here, and only because its primary candidate is
 * now the structural composer pill: a text-exact key would resolve to nothing on
 * a page whose label is merely off-list and would therefore have relabelled a
 * state as drift -- the very defect this list exists to avoid. The sibling
 * `thinkingPowerSlider` must NOT be listed: it mounts only once the menu is open.
 */
export const TURN_CRITICAL_SELECTORS: Array<keyof SelectorSet> = [
  "composer",
  "modelSwitcher",
  "thinkingPowerButton",
  "projectsNavigation",
];

export function joinSelectors(set: string[]): string {
  return set.join(", ");
}
