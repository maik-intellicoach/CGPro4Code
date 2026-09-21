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

export interface ModelsFetch {
  models: ChatgptModel[];
  /** The HTTP status the read actually got; -1 when the read never reached the API. */
  status: number;
  /** Why `models` is what it is, in words a log line can carry. */
  reason: string;
}

/**
 * P-035 2026-09-21. The same read, saying WHY it came back empty.
 *
 * The swallow this replaces cost real diagnosis: `if (!r.ok) return []` made a
 * failed token read (a real 401) and a healthy catalogue that simply lists no
 * Pro model indistinguishable, and the caller then reported the second when what
 * had happened was the first. A gate that fails closed is only honest if its
 * failure names its own cause.
 */
export async function fetchModelsWithReason(page: Page, _accessToken?: string): Promise<ModelsFetch> {
  const r = await backendApiFetch(
    page,
    "/backend-api/models?history_and_training_disabled=false",
  );
  if (!r.ok) return { models: [], status: r.status, reason: `http ${r.status}` };
  const json = r.body as ModelsResponse | null;
  const models = json?.models ?? [];
  return {
    models,
    status: r.status,
    reason: models.length === 0 ? `http ${r.status} answered without a models array` : `http ${r.status}`,
  };
}

export async function fetchModels(page: Page, accessToken?: string): Promise<ChatgptModel[]> {
  return (await fetchModelsWithReason(page, accessToken)).models;
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
