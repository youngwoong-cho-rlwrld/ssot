export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { API_BASE, CLUSTERS_TIMEOUT_MS, fetchUpstreamJson } from "@/lib/upstream";
import { normalizeClusterNames } from "@/lib/clusters";

export async function GET() {
  const upstream = new URL("/api/clusters", API_BASE);
  try {
    const payload = await fetchUpstreamJson<unknown>(upstream, CLUSTERS_TIMEOUT_MS);
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
