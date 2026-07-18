export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import {
  API_BASE,
  RESULT_CLUSTER_TIMEOUT_MS,
  fetchUpstreamJson,
} from "../../../lib/upstream.ts";
import {
  isValidClusterName,
  MAX_CLUSTER_COUNT,
  MAX_CLUSTER_LENGTH,
} from "../../../lib/clusters.ts";
import {
  enrichResultsPayloadWithConfigs,
  resultsConfigsRoot,
} from "../../../lib/experimentConfig.ts";

// The gateway injects the signed-in user's experiment-configs root override on
// proxied requests. It is absent when the app is reached without the gateway.
const CONFIGS_ROOT_HEADER = "x-ssot-results-configs-root";
const CACHE_FRESH_MS = 60_000;
const MAX_RESULTS_CACHE_ENTRIES = MAX_CLUSTER_COUNT;

type ResultsPayload = {
  clusters?: unknown[];
  variants?: unknown[];
  errors?: unknown[];
};

type ResultsCacheEntry = {
  payload: ResultsPayload;
  fetchedAt: number;
};

// Successful scans are served stale-while-revalidate. The bounded LRU keeps
// arbitrary valid cluster names from growing process memory without limit,
// and the in-flight map ensures only one upstream scan runs per cluster.
const resultsCache = new Map<string, ResultsCacheEntry>();
const inflightScans = new Map<string, Promise<ResultsPayload>>();

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

  const configsRoot = resultsConfigsRoot(request.headers.get(CONFIGS_ROOT_HEADER));

  try {
    const payload = await clusterResultsPayload(
      cluster,
      incoming.searchParams.get("fresh") === "1",
    );
    return Response.json(await enrichResultsPayloadWithConfigs(payload, configsRoot));
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

async function clusterResultsPayload(
  cluster: string,
  fresh: boolean,
): Promise<ResultsPayload> {
  if (!fresh) {
    const cached = getCachedResults(cluster);
    if (cached) {
      if (Date.now() - cached.fetchedAt > CACHE_FRESH_MS) {
        void scanCluster(cluster).catch(() => {});
      }
      return cached.payload;
    }
  }
  return scanCluster(cluster);
}

function scanCluster(cluster: string): Promise<ResultsPayload> {
  const inflight = inflightScans.get(cluster);
  if (inflight) return inflight;

  const scan = fetchResultsPayload(cluster)
    .then((payload) => {
      if (!payload.errors?.length) cacheResults(cluster, payload);
      return payload;
    })
    .finally(() => {
      if (inflightScans.get(cluster) === scan) inflightScans.delete(cluster);
    });
  inflightScans.set(cluster, scan);
  return scan;
}

function getCachedResults(cluster: string) {
  const cached = resultsCache.get(cluster);
  if (!cached) return undefined;

  resultsCache.delete(cluster);
  resultsCache.set(cluster, cached);
  return cached;
}

function cacheResults(cluster: string, payload: ResultsPayload) {
  resultsCache.delete(cluster);
  resultsCache.set(cluster, { payload, fetchedAt: Date.now() });

  while (resultsCache.size > MAX_RESULTS_CACHE_ENTRIES) {
    const oldestCluster = resultsCache.keys().next().value;
    if (oldestCluster === undefined) break;
    resultsCache.delete(oldestCluster);
  }
}

async function fetchResultsPayload(cluster: string): Promise<ResultsPayload> {
  const upstream = new URL("/api/results", API_BASE);
  upstream.searchParams.set("cluster", cluster);
  return fetchUpstreamJson<ResultsPayload>(upstream, RESULT_CLUSTER_TIMEOUT_MS);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
