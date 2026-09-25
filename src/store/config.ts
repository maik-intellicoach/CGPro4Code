import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CONFIG_FILE, ensureDirs } from "./paths.js";

export interface CgproConfig {
  /** Optional. When unset, chatgpt.com picks the user's account default. */
  defaultModel?: string;
  defaultWeb: boolean;
  defaultHeadless: boolean;
  timeoutSec: number;
}

const DEFAULTS: CgproConfig = {
  // Force the Pro slug: the account default is a non-Pro model. P-035
  // 2026-09-26: gpt-6-pro, not gpt-5-5-pro. The Pro-6 maximum gate runs only
  // for this exact slug, so a bare `cgpro ask` (the research pulse's
  // no-daemon route) asked GPT-5.5 Pro unverified; gpt-5.x is retired here.
  defaultModel: "gpt-6-pro",
  defaultWeb: true,
  defaultHeadless: false,
  // GPT-5.5 Pro extended-thinking turns can run over an hour for hard
  // problems. Default to 2h; user can lower via --timeout for ergonomics
  // on quick turns or raise it explicitly. The daemon clamps separately.
  timeoutSec: 7_200,
};

export function loadConfig(): CgproConfig {
  ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CgproConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: CgproConfig): void {
  ensureDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}
