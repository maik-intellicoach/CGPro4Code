import type { Page } from "patchright";
import { backendApiFetch } from "../browser/chatgpt.js";

export interface ChatgptModel {
  slug: string;
  title?: string;
  description?: string;
  /** Whether the slug is selectable in the picker (`list`) or hidden (`hidden`). */
  visibility?: string;
  tags?: string[];
}

export interface ModelsResponse {
  models: ChatgptModel[];
  categories?: unknown[];
}

export async function fetchModels(page: Page, _accessToken?: string): Promise<ChatgptModel[]> {
  const r = await backendApiFetch(
    page,
    "/backend-api/models?history_and_training_disabled=false",
  );
  if (!r.ok) return [];
  const json = r.body as ModelsResponse | null;
  return json?.models ?? [];
}

/**
 * Picks the Pro model itself from the catalogue, not just its slug.
 *
 * P-035 2026-09-21. Verification needs the model's own TITLE as well as its
 * slug: hardcoding the label the composer should show is what broke the 6 Pro
 * gate, and the account's catalogue already states the label in its own
 * vocabulary. Callers that only need the slug should use findProSlug.
 */
export function findProModel(models: ChatgptModel[]): ChatgptModel | null {
  const candidates = models.filter((m) => {
    const blob = `${m.slug ?? ""} ${m.title ?? ""}`.toLowerCase();
    return (
      blob.includes("pro") &&
      (blob.includes("5.5") || blob.includes("5-5") || blob.includes("5_5") || blob.includes("5pro"))
    );
  });
  if (candidates.length === 0) {
    // Fallback: any "pro" model
    return models.find((m) => (m.slug ?? "").toLowerCase().includes("pro")) ?? null;
  }
  // Prefer one whose slug actually contains 'pro'
  return candidates.find((m) => (m.slug ?? "").toLowerCase().includes("pro")) ?? candidates[0];
}

/**
 * Picks the best slug for "GPT-5.5 Pro" from the catalogue.
 * The exact slug varies (gpt-5-5-pro, gpt-5.5-pro, gpt-5-pro, …) so we
 * match flexibly on the slug + title.
 */
export function findProSlug(models: ChatgptModel[]): string | null {
  return findProModel(models)?.slug ?? null;
}

/**
 * The normalised form two labels are compared in: lowercase, a leading `gpt`
 * dropped, and every non-alphanumeric removed, so catalogue titles and composer
 * labels that name the same model compare equal however the UI spaces or
 * hyphenates them (`GPT-6 Pro`, `6 Pro`, `6Pro` all normalise to `6pro`).
 *
 * Deliberately exact otherwise: `6` and `Extra High` normalise to themselves and
 * do NOT match, which is what keeps a lower or older state out of this gate.
 */
export function normaliseModelLabel(label: string | null | undefined): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/gpt/g, "")
    .replace(/[^a-z0-9]/g, "");
}
