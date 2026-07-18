/**
 * Model + harness resolution shared by the submit flow. Both the model family
 * and the eval harness are authoritative from the backend model registry
 * (served on /api/variants/{name} as `model_family` / `harness`); these helpers
 * centralize the fallbacks so the UI reads them consistently.
 */

type EvalHarness = "isaac" | "dexjoco";

/**
 * Resolve the variant's model identity. `modelFamily` (the backend registry's
 * answer) wins when present — the raw `MODEL_ID` can't tell the UI that e.g.
 * dexjoco-* ids are n1.6-family. `modelId` falls back through
 * MODEL_ID -> MODEL_VERSION -> "n1.5"; `model` uses the registry family and
 * only falls back to `modelId` when the registry didn't answer.
 */
export function resolveModel(
  vars: Record<string, string> | undefined,
  modelFamily?: string | null,
): { modelId: string; model: string } {
  const modelId = vars?.MODEL_ID ?? vars?.MODEL_VERSION ?? "n1.5";
  const model = modelFamily ?? modelId;
  return { modelId, model };
}

/**
 * The eval harness for a variant, from the backend registry's `harness`
 * (derived from the model's eval body script). Defaults to "isaac" when the
 * registry didn't answer (unknown MODEL_ID).
 */
export function evalHarness(harness?: string | null): EvalHarness {
  return harness === "dexjoco" ? "dexjoco" : "isaac";
}
