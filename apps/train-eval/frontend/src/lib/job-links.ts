export function jobDetailHref(cluster: string, jobId?: string | null) {
  if (!jobId) return undefined;
  return `/jobs/${encodeURIComponent(cluster)}/${encodeURIComponent(jobId)}`;
}

export function jobVideosHref(cluster: string, jobId?: string | null) {
  const base = jobDetailHref(cluster, jobId);
  return base ? `${base}/videos` : undefined;
}

/** URL-friendly key identifying an eval run, shared by the videos page and the
 *  ?run= deep-links that target it. */
export function evalRunSlug(parts: {
  task: string | null;
  eval_set: string;
  run: string;
}): string {
  return [parts.task, parts.eval_set, parts.run].filter(Boolean).join("/");
}
