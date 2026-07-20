export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import {
  fetchOpenClawJson,
  openClawApiUrl,
  OPENCLAW_MODELS_TIMEOUT_MS,
} from "../../../../lib/openclawUpstream.ts";
import { requireSsotUser } from "../../../../lib/ssotAuth.ts";

export async function GET(request: Request) {
  const unauthorized = requireSsotUser(request);
  if (unauthorized) return unauthorized;
  try {
    const payload = await fetchOpenClawJson<unknown>(
      openClawApiUrl("/api/models"),
      { signal: request.signal },
      OPENCLAW_MODELS_TIMEOUT_MS,
    );
    return Response.json(payload);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
