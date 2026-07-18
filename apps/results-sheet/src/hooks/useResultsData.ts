import {
  keepPreviousData,
  useIsFetching,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { ResultsResponse } from "../lib/results";
import { normalizeResultsPayload } from "../lib/resultsPayload";
import { normalizeClusterNames } from "../lib/clusters";
import { apiPath } from "../lib/basePath";

const CLUSTERS_STALE_MS = 5 * 60_000;
const RESULTS_REFRESH_MS = 120_000;
const FORCE_FRESH_WINDOW_MS = 15_000;

let forceFreshUntil = 0;

export function useResultsData() {
  const queryClient = useQueryClient();
  const clustersQuery = useQuery({
    queryKey: ["clusters"],
    queryFn: fetchClusterNames,
    staleTime: CLUSTERS_STALE_MS,
  });
  const clusterNames = useMemo(() => clustersQuery.data ?? [], [clustersQuery.data]);
  const resultQueries = useQueries({
    queries: clusterNames.map((cluster) => ({
      queryKey: ["results", cluster],
      queryFn: () => fetchClusterResults(cluster),
      refetchInterval: RESULTS_REFRESH_MS,
      placeholderData: keepPreviousData,
    })),
    combine: combineResultQueries,
  });
  const response = useMemo<ResultsResponse>(() => ({
    variants: resultQueries.payloads.flatMap((payload) => payload.variants),
    errors: resultQueries.payloads.flatMap((payload) => payload.errors),
  }), [clusterNames, resultQueries.payloads]);
  const isFetching = useIsFetching({
    predicate: (query) => query.queryKey[0] === "results" || query.queryKey[0] === "clusters",
  }) > 0;
  const anyResultLoaded = resultQueries.anyLoaded;
  const initialLoading = clustersQuery.isLoading || (
    clusterNames.length > 0 && !resultQueries.anyLoaded && resultQueries.anyLoading
  );
  const refresh = useCallback(() => {
    forceFreshUntil = Date.now() + FORCE_FRESH_WINDOW_MS;
    void queryClient.invalidateQueries({ queryKey: ["clusters"] });
    void queryClient.invalidateQueries({ queryKey: ["results"] });
  }, [queryClient]);

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

async function fetchClusterResults(cluster: string): Promise<ResultsResponse> {
  const freshParam = Date.now() < forceFreshUntil ? "&fresh=1" : "";
  try {
    const payload = await fetchJson<unknown>(
      apiPath(`/api/results?cluster=${encodeURIComponent(cluster)}${freshParam}`),
    );
    return normalizeResultsPayload(payload, cluster);
  } catch (error) {
    return {
      variants: [],
      errors: [{ cluster, error: error instanceof Error ? error.message : String(error) }],
    };
  }
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

function combineResultQueries(results: UseQueryResult<ResultsResponse>[]) {
  return {
    payloads: results.flatMap((result) => result.data ? [result.data] : []),
    anyLoaded: results.some((result) => result.data !== undefined),
    anyLoading: results.some((result) => result.isLoading),
  };
}
