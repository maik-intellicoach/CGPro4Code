/**
 * All ChatGPT.com DOM selectors live here. When OpenAI ships a UI change,
 * patch this file. Each entry has a primary selector + ordered fallbacks.
 *
 * Verified against chatgpt.com as of April 25, 2026.
 */

export interface SelectorSet {
  /** Composer textarea (#prompt-textarea is a stable ID since at least 2024). */
  composer: string[];
  /** Send/submit button next to the composer. */
  sendButton: string[];
  /** Stop-streaming button (visible only while the model is producing tokens). */
  stopButton: string[];
  /** Model picker / dropdown trigger in the conversation header. */
  modelSwitcher: string[];
  /** Web search composer toggle. */
  webSearchToggle: string[];
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
}

/**
 * Verified against chatgpt.com as of April 27, 2026.
 *
 * OpenAI removed most data-message-* attributes and many data-testid
 * values in their late-April 2026 UI rewrite. Assistant messages are
 * now identified by `[data-message-author-role]` (if still present) OR
 * by structural selectors inside <article> / the thread container.
 * data-testid values that survived the rewrite are preferred; the rest
 * are structural / aria fallbacks.
 */
export const SELECTORS: SelectorSet = {
  composer: [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Envoyer"]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Arrêter"]',
  ],
  modelSwitcher: [
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[aria-label="Model selector"]',
    'button[aria-label*="Model selector"]',
    'button[aria-label*="Sélecteur"]',
  ],
  webSearchToggle: [
    '[role="menuitemradio"]:has-text("Web search")',
    '[role="menuitemradio"]:has-text("Recherche web")',
    'div[role="menuitemradio"]:has-text("Web")',
    'button[data-testid="composer-tool-web-search"]',
    'button[aria-label*="Search the web"]',
    'button[aria-label*="web search" i]',
  ],
  accountMenu: [
    'button[data-testid="accounts-profile-button"]',
    'button[data-testid="profile-button"]',
    'button[data-testid="user-menu-button"]',
    'nav button:has(img[alt])',
  ],
  assistantMessages: [
    'div[data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn-"] div[data-message-author-role="assistant"]',
    // Late-April 2026 fallback: article children in the thread container
    'article:nth-child(even)',
  ],
  anyMessages: [
    "div[data-message-author-role]",
    "[data-message-author-role]",
    'article[data-testid^="conversation-turn-"]',
    "article",
  ],
  assistantActionBar: [
    'div[role="group"][aria-label*="Actions"]',
    '[data-testid="message-actions"]',
  ],
  assistantMarkdown: [
    "div.markdown",
    ".prose",
    '[class*="markdown"]',
    '[data-message-author-role="assistant"]',
  ],
  conversationList: [
    '[data-testid="conversation-list"]',
    'nav[aria-label="Chat history"]',
    'nav[aria-label*="historique" i]',
  ],
  conversationItem: [
    '[data-testid^="history-item-"]',
    '[data-testid="conversation-item"]',
    'nav a[href^="/c/"]',
    'nav li a[href^="/c/"]',
  ],
  newChatButton: [
    'button[data-testid="create-new-chat-button"]',
    'a[data-testid="create-new-chat-button"]',
    'a[href="/"]:has(svg)',
  ],
  fileUpload: [
    'input[type="file"][data-testid="upload-photos-input"]',
    'input[type="file"][data-testid="file-upload"]',
    'input[type="file"]',
  ],
};

export function joinSelectors(set: string[]): string {
  return set.join(", ");
}
