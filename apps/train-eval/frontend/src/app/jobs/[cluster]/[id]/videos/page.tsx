"use client";

import { use, useEffect, useRef } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  api,
  videoStreamUrl,
  type EvalRun,
  type JobEvalRuns,
  type VideoFile,
  type VideoListing,
} from "@/lib/api";
import { formatPct } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/loading-state";
import { evalRunSlug, jobDetailHref } from "@/lib/job-links";

const REFRESH_MS = 60_000;

function runDirOf(resultsPath: string): string {
  const i = resultsPath.lastIndexOf("/");
  return i >= 0 ? resultsPath.slice(0, i) : resultsPath;
}

function relDir(evalDir: string | null, absDir: string): string {
  if (evalDir && absDir.startsWith(evalDir + "/")) return absDir.slice(evalDir.length + 1);
  return absDir;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatSuccess(row: EvalRun): string | null {
  const rate = row.success_rate == null ? null : formatPct(row.success_rate);
  if (row.success_count != null && row.total_episodes != null) {
    return `${row.success_count}/${row.total_episodes}${rate ? ` (${rate})` : ""}`;
  }
  return rate;
}

type RunSection = {
  slug: string;
  run: EvalRun | null;
  runDir: string;
  videos: VideoFile[];
};

function buildSections(
  evalRuns: EvalRun[],
  listing: VideoListing | undefined,
): RunSection[] {
  const videos = listing?.videos ?? [];
  const byDir = new Map<string, VideoFile[]>();
  for (const v of videos) {
    const arr = byDir.get(v.run_dir);
    if (arr) arr.push(v);
    else byDir.set(v.run_dir, [v]);
  }

  const sections: RunSection[] = [];
  const seen = new Set<string>();
  // Eval runs first, so sections read in the same order as the Eval Runs table.
  for (const run of evalRuns) {
    const dir = runDirOf(run.path);
    const runVideos = byDir.get(dir);
    if (!runVideos) continue;
    seen.add(dir);
    sections.push({ slug: evalRunSlug(run), run, runDir: dir, videos: runVideos });
  }
  // Any video groups with no matching eval run (results.json not written yet).
  for (const [dir, runVideos] of byDir) {
    if (seen.has(dir)) continue;
    sections.push({
      slug: relDir(listing?.eval_dir ?? null, dir),
      run: null,
      runDir: dir,
      videos: runVideos,
    });
  }
  return sections;
}

export default function JobVideos({
  params,
  searchParams,
}: {
  params: Promise<{ cluster: string; id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { cluster, id } = use(params);
  const { run: runParam } = use(searchParams);

  const evalRuns = useQuery({
    queryKey: ["job-eval-runs", cluster, id],
    queryFn: () => api<JobEvalRuns>(`/api/jobs/${cluster}/${id}/eval-runs`),
    refetchInterval: REFRESH_MS,
  });
  const videos = useQuery({
    queryKey: ["job-videos", cluster, id],
    queryFn: () => api<VideoListing>(`/api/jobs/${cluster}/${id}/videos`),
    refetchInterval: REFRESH_MS,
  });

  const isLoading = evalRuns.isLoading || videos.isLoading;
  const error = (evalRuns.error ?? videos.error) as Error | null;

  const allSections = buildSections(evalRuns.data?.eval_runs ?? [], videos.data);
  const filtered = runParam
    ? allSections.filter((s) => s.slug === runParam)
    : allSections;
  const sections = filtered.length > 0 ? filtered : allSections;
  const filterActive = Boolean(runParam) && filtered.length > 0;

  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (runParam && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [runParam, isLoading]);

  const harness = videos.data?.eval_harness;
  const emptyMessage =
    harness === "dexjoco"
      ? "No videos found. DexJoCo eval runs don't record episode mp4s."
      : "No episode videos were found for this job.";

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <Link
        href={jobDetailHref(cluster, id)!}
        className="inline-flex items-center gap-1 text-sm text-[var(--ssot-text-soft)] transition-colors hover:text-slate-900 dark:hover:text-slate-50"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to job {id}
      </Link>

      <div className="mt-4 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Eval videos <span className="font-mono">{id}</span>{" "}
          <span className="text-slate-400">·</span>{" "}
          <span className="text-[var(--ssot-text-soft)]">{cluster}</span>
        </h1>
      </div>

      {filterActive && (
        <div className="mt-2 text-sm text-[var(--ssot-text-soft)]">
          Showing one run.{" "}
          <Link
            href={`${jobDetailHref(cluster, id)}/videos`}
            className="text-[var(--ssot-accent)] hover:underline"
          >
            Show all runs
          </Link>
        </div>
      )}

      <div className="mt-6">
        {isLoading && <LoadingState label="Loading videos..." />}
        {!isLoading && error && <ErrorState message={error.message} />}
        {!isLoading && !error && sections.length === 0 && (
          <EmptyState message={emptyMessage} />
        )}
        {!isLoading &&
          !error &&
          sections.map((section) => {
            const isActive = section.slug === runParam;
            return (
              <Card
                key={section.runDir}
                id={section.slug}
                ref={isActive ? activeRef : undefined}
                className="mt-6 scroll-mt-8"
              >
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
                    {section.run?.task && (
                      <span className="font-mono">{section.run.task}</span>
                    )}
                    <span className="font-mono text-[var(--ssot-accent)]">
                      {section.run?.eval_set ?? relDir(videos.data?.eval_dir ?? null, section.runDir)}
                    </span>
                    {section.run && (
                      <span className="font-mono text-sm text-[var(--ssot-text-soft)]">
                        {section.run.run}
                      </span>
                    )}
                    {section.run?.seed != null && (
                      <span className="text-sm font-normal text-[var(--ssot-text-soft)]">
                        seed {section.run.seed}
                      </span>
                    )}
                    {section.run && formatSuccess(section.run) && (
                      <span className="text-sm font-normal text-[var(--ssot-text-soft)]">
                        {formatSuccess(section.run)}
                      </span>
                    )}
                    <span className="text-sm font-normal text-slate-400">
                      {section.videos.length} episodes
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {section.videos.map((v) => (
                      <div key={v.path} className="min-w-0">
                        <video
                          controls
                          preload="metadata"
                          src={videoStreamUrl(cluster, id, v.path)}
                          className="w-full rounded-md border border-slate-200 bg-black dark:border-slate-800"
                        />
                        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-[var(--ssot-text-soft)]">
                          <span className="truncate font-mono">{v.episode}</span>
                          <span className="shrink-0">{formatSize(v.size)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
      </div>
    </div>
  );
}
