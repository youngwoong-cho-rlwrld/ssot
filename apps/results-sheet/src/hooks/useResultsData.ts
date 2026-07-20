import {
  keepPreviousData,
  useIsFetching,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { ResultsResponse } from "../lib/results";
import { normalizeResultsPayload } from "../lib/resultsPayload";
import { normalizeClusterNames } from "../lib/clusters";
import { apiPath } from "../lib/basePath";

const CLUSTERS_STALE_MS = 5 * 60_000;
const RESULTS_REFRESH_MS = 120_000;
export function useResultsData() {
  const queryClient = useQueryClient();
  const freshClustersRef = useRef(new Set<string>());
  const clustersQuery = useQuery({
    queryKey: ["clusters"],
    queryFn: fetchClusterNames,
    staleTime: CLUSTERS_STALE_MS,
  });
  const clusterNames = useMemo(() => clustersQuery.data ?? [], [clustersQuery.data]);
  const resultQueries = useQueries({
    queries: clusterNames.map((cluster) => ({
      queryKey: ["results", cluster],
      queryFn: () => fetchClusterResults(
        cluster,
        freshClustersRef.current.delete(cluster),
      ),
      refetchInterval: (query: { state: { data?: ResultsResponse } }) => (
        query.state.data?.stale ? 5_000 : RESULTS_REFRESH_MS
      ),
      placeholderData: keepPreviousData,
    })),
    combine: (results) => combineResultQueries(clusterNames, results),
  });
  const response = useMemo<ResultsResponse>(() => ({
    variants: resultQueries.payloads.flatMap((payload) => payload.variants),
    errors: [
      ...resultQueries.payloads.flatMap((payload) => payload.errors),
      ...resultQueries.failures,
    ],
    fetchedAt: Object.assign(
      {},
      ...resultQueries.payloads.map((payload) => payload.fetchedAt ?? {}),
    ),
    stale: resultQueries.payloads.some((payload) => payload.stale === true),
  }), [resultQueries.failures, resultQueries.payloads]);
  const isFetching = useIsFetching({
    predicate: (query) => query.queryKey[0] === "results" || query.queryKey[0] === "clusters",
  }) > 0;
  const anyResultLoaded = resultQueries.anyLoaded;
  const initialLoading = clustersQuery.isLoading || (
    clusterNames.length > 0 && !resultQueries.anyLoaded && resultQueries.anyLoading
  );
  const refresh = useCallback(() => {
    for (const cluster of clusterNames) freshClustersRef.current.add(cluster);
    void queryClient.invalidateQueries({ queryKey: ["clusters"] });
    void queryClient.invalidateQueries({ queryKey: ["results"] });
  }, [clusterNames, queryClient]);

  return {
    response,
    isFetching,
    anyResultLoaded,
    initialLoading,
    loadError: clustersQuery.error instanceof Error ? clustersQuery.error.message : "",
    refresh,
  };
}

async function fetchClusterNames() {
  const payload = await fetchJson<{ clusters?: unknown }>(apiPath("/api/clusters"));
  return normalizeClusterNames(payload.clusters);
}

async function fetchClusterResults(cluster: string, fresh: boolean): Promise<ResultsResponse> {
  const payload = await fetchJson<unknown>(
    apiPath(`/api/results?cluster=${encodeURIComponent(cluster)}${fresh ? "&fresh=1" : ""}`),
  );
  return normalizeResultsPayload(payload, cluster);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(payloadErrorMessage(payload) ?? `${response.status} ${response.statusText}`);
  }
  return payload as T;
}

function payloadErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (!Array.isArray(record.errors)) return null;
  const first = record.errors[0];
  return first && typeof first === "object" && typeof (first as Record<string, unknown>).error === "string"
    ? String((first as Record<string, unknown>).error)
    : null;
}

function combineResultQueries(
  clusters: string[],
  results: UseQueryResult<ResultsResponse>[],
) {
  return {
    payloads: results.flatMap((result) => result.data ? [result.data] : []),
    failures: results.flatMap((result, index) => (
      result.error
        ? [{
            cluster: clusters[index] ?? "unknown",
            error: result.error instanceof Error ? result.error.message : String(result.error),
          }]
        : []
    )),
    anyLoaded: results.some((result) => result.data !== undefined),
    anyLoading: results.some((result) => result.isLoading),
  };
}
