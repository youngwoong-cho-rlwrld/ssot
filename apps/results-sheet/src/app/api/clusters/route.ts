export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import {
  API_BASE,
  CLUSTERS_TIMEOUT_MS,
  fetchUpstreamJson,
} from "../../../lib/upstream.ts";
import { normalizeClusterNames } from "../../../lib/clusters.ts";

const USER_HEADER = "x-ssot-user";

export async function GET(request: Request) {
  const upstream = new URL("/api/clusters", API_BASE);
  try {
    const user = request.headers.get(USER_HEADER);
    const payload = await fetchUpstreamJson<unknown>(
      upstream,
      CLUSTERS_TIMEOUT_MS,
      user ? { [USER_HEADER]: user } : {},
    );
    const clusters = payload && typeof payload === "object"
      ? normalizeClusterNames((payload as Record<string, unknown>).clusters)
      : [];
    return Response.json({ clusters });
  } catch (error) {
    return Response.json(
      {
        clusters: [],
        error: `Could not reach ${upstream.toString()}: ${(error as Error).message}`,
      },
      { status: 502 },
    );
  }
}
