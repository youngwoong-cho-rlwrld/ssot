"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type VariantSummary } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/loading-state";
import { cn } from "@/lib/utils";

const ALL_MODELS = "__all__";

export default function ExperimentsPage() {
  const summaries = useQuery({
    queryKey: ["variant-summaries"],
    queryFn: () =>
      api<{ summaries: VariantSummary[] }>("/api/variants/summaries").then((d) => d.summaries),
  });

  return (
    <div className="ssot-page">
      <h1 className="text-xl font-semibold tracking-tight">Experiments</h1>

      {summaries.isLoading && (
        <div className="mt-8">
          <LoadingState label="Loading experiments..." rows={5} />
        </div>
      )}
      {summaries.error && (
        <div className="mt-8">
          <ErrorState message={(summaries.error as Error).message} />
        </div>
      )}
      {summaries.data && <ExperimentsBrowser summaries={summaries.data} />}
    </div>
  );
}

function ExperimentsBrowser({ summaries }: { summaries: VariantSummary[] }) {
  const [modelId, setModelId] = useState<string>(ALL_MODELS);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [search, setSearch] = useState<string>("");

  const modelOptions = useMemo(
    () =>
      Array.from(new Set(summaries.map((s) => s.model_id).filter((m): m is string => !!m))).sort(),
    [summaries],
  );

  // Experiments matching the MODEL_ID filter; dataset chips are derived from
  // this set so the two filters compose (you only see datasets in scope).
  const modelFiltered = useMemo(
    () => (modelId === ALL_MODELS ? summaries : summaries.filter((s) => s.model_id === modelId)),
    [summaries, modelId],
  );

  const datasetOptions = useMemo(
    () => Array.from(new Set(modelFiltered.flatMap((s) => s.dataset_names))).sort(),
    [modelFiltered],
  );

  // A dataset filter matches an experiment that uses ANY of the selected
  // datasets (union). Stale selections (not in the current model scope) are
  // ignored rather than hiding everything.
  const activeDatasets = useMemo(
    () => datasets.filter((d) => datasetOptions.includes(d)),
    [datasets, datasetOptions],
  );

  // Case-insensitive substring match on the experiment name and its model id.
  const searchNeedle = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      modelFiltered.filter(
        (s) =>
          (activeDatasets.length === 0 ||
            s.dataset_names.some((d) => activeDatasets.includes(d))) &&
          (searchNeedle === "" ||
            s.name.toLowerCase().includes(searchNeedle) ||
            (s.model_id?.toLowerCase().includes(searchNeedle) ?? false)),
      ),
    [modelFiltered, activeDatasets, searchNeedle],
  );

  function toggleDataset(name: string) {
    setDatasets((prev) =>
      prev.includes(name) ? prev.filter((d) => d !== name) : [...prev, name],
    );
  }

  const hasFilters =
    modelId !== ALL_MODELS || activeDatasets.length > 0 || searchNeedle !== "";

  function clearFilters() {
    setModelId(ALL_MODELS);
    setDatasets([]);
    setSearch("");
  }

  return (
    <>
      <Card className="mt-8">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Filters</CardTitle>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 text-xs text-[var(--ssot-text-soft)] transition-colors hover:text-[var(--ssot-accent)]"
            >
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-64 space-y-1.5">
              <Label htmlFor="experiment-search">Search</Label>
              <Input
                id="experiment-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="filter by name..."
                className="font-mono text-xs"
              />
            </div>
            <div className="w-64 space-y-1.5">
              <Label>MODEL_ID</Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_MODELS}>All models</SelectItem>
                  {modelOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      <span className="font-mono text-xs">{m}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>
              Train datasets
              {activeDatasets.length > 0 && (
                <span className="ml-2 font-normal text-slate-400">
                  {activeDatasets.length} selected
                </span>
              )}
            </Label>
            {datasetOptions.length === 0 ? (
              <p className="text-xs text-slate-400">No datasets in scope.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {datasetOptions.map((name) => {
                  const active = activeDatasets.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleDataset(name)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 font-mono text-xs transition-colors",
                        active
                          ? "border-[var(--ssot-accent)] bg-[var(--ssot-accent)] text-white"
                          : "border-[var(--ssot-border-strong)] text-[var(--ssot-text-soft)] hover:border-[var(--ssot-accent)] hover:bg-[var(--ssot-accent-soft)]",
                      )}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            All experiments
            <span className="ml-2 text-sm font-normal text-slate-400">
              {filtered.length}
              {filtered.length !== summaries.length && ` of ${summaries.length}`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <EmptyState message="No experiments match the current filters." />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-900">
              {filtered.map((s) => (
                <li key={s.name} className="flex items-center justify-between gap-4 py-2">
                  <Link
                    href={`/experiments/${encodeURIComponent(s.name)}`}
                    className="font-mono text-sm text-[var(--ssot-accent)] hover:underline"
                  >
                    {s.name}
                  </Link>
                  {s.model_id && (
                    <span className="shrink-0 font-mono text-xs text-slate-400">{s.model_id}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
