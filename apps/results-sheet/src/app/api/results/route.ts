export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import {
  API_BASE,
  RESULT_CLUSTER_TIMEOUT_MS,
  fetchUpstreamJson,
} from "../../../lib/upstream.ts";
import {
  isValidClusterName,
  MAX_CLUSTER_LENGTH,
} from "../../../lib/clusters.ts";
import {
  enrichResultsPayloadWithConfigs,
  resultsConfigsRoot,
} from "../../../lib/experimentConfig.ts";

// The gateway injects the signed-in user's experiment-configs root override on
// proxied requests. It is absent when the app is reached without the gateway.
const CONFIGS_ROOT_HEADER = "x-ssot-results-configs-root";
const CONFIGS_CONFIGURED_HEADER = "x-ssot-results-configs-configured";
const USER_HEADER = "x-ssot-user";
type ResultsPayload = {
  clusters?: unknown[];
  variants?: unknown[];
  errors?: unknown[];
  fetched_at?: unknown;
  stale?: unknown;
};

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const clusterValues = incoming.searchParams.getAll("cluster");
  if (clusterValues.length !== 1) {
    return badRequest(
      clusterValues.length
        ? 'The "cluster" query parameter may be specified only once.'
        : 'The "cluster" query parameter is required.',
    );
  }

  const cluster = clusterValues[0] ?? "";
  if (!isValidClusterName(cluster)) {
    return badRequest(
      `The "cluster" query parameter must be 1-${MAX_CLUSTER_LENGTH} characters, use only letters, numbers, ".", "_", or "-", and start and end with a letter or number.`,
    );
  }

  const configsRoot =
    request.headers.get(CONFIGS_CONFIGURED_HEADER) === "0"
      ? null
      : resultsConfigsRoot(request.headers.get(CONFIGS_ROOT_HEADER));

  try {
    const payload = await fetchResultsPayload(
      cluster,
      incoming.searchParams.get("fresh") === "1",
      request.headers.get(USER_HEADER),
    );
    return Response.json(
      configsRoot
        ? await enrichResultsPayloadWithConfigs(payload, configsRoot)
        : payload,
    );
  } catch (error) {
    return Response.json(
      {
        clusters: [cluster],
        variants: [],
        errors: [
          {
            cluster,
            error: `Could not reach ${API_BASE}: ${errorMessage(error)}`,
          },
        ],
      },
      { status: 502 },
    );
  }
}

function badRequest(error: string) {
  return Response.json({ error }, { status: 400 });
}

async function fetchResultsPayload(
  cluster: string,
  fresh: boolean,
  user: string | null,
): Promise<ResultsPayload> {
  const upstream = new URL("/api/results", API_BASE);
  upstream.searchParams.set("cluster", cluster);
  if (fresh) upstream.searchParams.set("fresh", "1");
  return fetchUpstreamJson<ResultsPayload>(
    upstream,
    RESULT_CLUSTER_TIMEOUT_MS,
    user ? { [USER_HEADER]: user } : {},
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
