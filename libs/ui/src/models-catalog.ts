import type { ModelSwitcherOption } from "./ModelSwitcher";

// THE canonical agent-model catalog — the single list every app's ModelSwitcher
// shows, in one order, so the three pickers (OpenClaw, model-diagram,
// results-sheet) are identical. 4 Anthropic + 5 OpenAI, pre-sorted Anthropic-first
// then by label; the labels are the exact display strings.
//
// SYNC: these ids + labels must stay in lockstep with model-diagram's backend
// MODEL_ALLOWLIST in apps/model-diagram/backend/app/settings.py. Edit both together.
export type ModelProvider = "anthropic" | "openai";

export interface CatalogModel {
  id: string;
  label: string;
  provider: ModelProvider;
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  { id: "claude-fable-5", label: "Claude Fable", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku", provider: "anthropic" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet", provider: "anthropic" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "openai" },
  { id: "gpt-5.6", label: "GPT-5.6", provider: "openai" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
  { id: "o1", label: "o1", provider: "openai" },
  { id: "o3", label: "o3", provider: "openai" },
];

// A backend's live model entry (from that app's /api/models). `key` is what the
// backend actually accepts for selection (OpenClaw uses "<provider>/<id>";
// model-diagram uses the plain id).
export interface BackendModel {
  key: string;
  available?: boolean;
}

// Match a canonical id to a backend entry: exact key, or the "<provider>/<id>"
// form OpenClaw's daemon uses (key ends with "/<id>"). Case-insensitive.
function matchBackend(canonicalId: string, backend: readonly BackendModel[]): BackendModel | undefined {
  const id = canonicalId.toLowerCase();
  return backend.find((entry) => {
    const key = (entry.key || "").toLowerCase();
    return key === id || key.endsWith(`/${id}`);
  });
}

// Build the ModelSwitcher option list for one app from the canonical catalog +
// that app's live backend models. EVERY canonical entry appears, in catalog order:
//  - matched + available  -> enabled; its `id` is the backend key (what selection sends)
//  - matched + unavailable -> disabled ("not available on this host")
//  - unmatched            -> disabled ("not configured on this host")
// No extra models are ever shown, none are ever missing.
export function resolveCatalog(backend: readonly BackendModel[]): ModelSwitcherOption[] {
  return MODEL_CATALOG.map((model) => {
    const match = matchBackend(model.id, backend);
    if (!match) {
      return {
        id: model.id,
        label: model.label,
        provider: model.provider,
        disabled: true,
        disabledReason: "Not configured on this host",
      };
    }
    const unavailable = match.available === false;
    return {
      id: match.key,
      label: model.label,
      provider: model.provider,
      disabled: unavailable,
      disabledReason: unavailable ? "Not available on this host" : undefined,
    };
  });
}
