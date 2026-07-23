"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Job, type SubmitResponse } from "@/lib/api";
import { jobDetailHref } from "@/lib/job-links";
import type { JobPhase } from "@/lib/job-status";
import { Modal } from "@ssot/ui/Modal";
import { Button } from "@/components/ui/button";
import { InlineLoading } from "@/components/loading-state";

type ResumeAction = "resume" | "retry";

export function ResumeJobButton({
  cluster,
  jobId,
  phase,
  variant,
  jobName,
  action = "resume",
  className,
}: {
  cluster: string;
  jobId: string;
  phase?: JobPhase | null;
  variant?: string | null;
  jobName?: string | null;
  action?: ResumeAction;
  className?: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const resumedJobs = useQuery({
    queryKey: ["resumed-jobs", cluster, jobId],
    queryFn: () => api<Job[]>(`/api/jobs/${cluster}/${jobId}/resumes`),
    enabled: open,
  });
  const resume = useMutation({
    mutationFn: () =>
      api<SubmitResponse>(`/api/jobs/${cluster}/${jobId}/${action}`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      toast.success(
        data.recovered
          ? `Job was already ${action === "retry" ? "retried" : "resumed"} as ${data.job_id} on ${cluster}`
          : `Submitted ${action} job ${data.job_id} on ${cluster}`,
      );
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job", cluster, jobId] });
      qc.invalidateQueries({ queryKey: ["job-details"] });
      qc.invalidateQueries({ queryKey: ["job-progress"] });
      qc.invalidateQueries({ queryKey: ["resumed-jobs", cluster, jobId] });
      router.push(`/jobs/${cluster}/${data.job_id}`);
    },
    onError: (err: Error) =>
      toast.error(`${action === "retry" ? "Retry" : "Resume"} failed: ${err.message}`),
  });

  const normalizedPhase = phase === "resume" ? "train" : phase;
  const phaseLabel = normalizedPhase === "train"
    ? "training"
    : normalizedPhase === "eval"
      ? "evaluation"
      : "job";
  const isRetry = action === "retry";
  const title = isRetry ? "Retry failed job?" : "Resume timed-out job?";
  const primaryLabel = isRetry ? "Retry" : "Resume";
  const submittingLabel = isRetry ? "Retrying..." : "Resuming...";
  const submitLabel = isRetry ? "Submit retry" : "Submit resume";

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        disabled={resume.isPending}
      >
        {resume.isPending ? submittingLabel : primaryLabel}
      </Button>

      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="modal__body space-y-2">
            <p className="[overflow-wrap:anywhere]">
              This submits a new {phaseLabel} job on{" "}
              <span className="font-mono">{cluster}</span> from {isRetry ? "failed" : "timed-out"} job{" "}
              <span className="font-mono">{jobId}</span>
              {variant ? (
                <>
                  {" "}for <span className="font-mono">{variant}</span>
                </>
              ) : null}
              .
            </p>
            {normalizedPhase === "train" ? (
              <p>
                {isRetry
                  ? "Training retry reuses the original submission settings and output namespace. If usable checkpoints already exist, the train script may continue from them; otherwise it starts the run again."
                  : "Training resumes from the latest checkpoint found for this experiment. New checkpoints and logs will be written by the new Slurm job."}
              </p>
            ) : normalizedPhase === "eval" ? (
              <p>
                Evaluation {isRetry ? "retry" : "resume"} seeds existing eval
                results into the staged experiment directory, skips runs that already have a
                <span className="font-mono"> results.json</span>, and rewrites
                aggregate result files as remaining runs complete.
              </p>
            ) : (
              <p>
                The backend will recover the original phase and experiment before
                submitting the replacement Slurm job.
              </p>
            )}
            <p>
              This can update staged result artifacts for the same experiment.
              Continue only if this is the {isRetry ? "failure" : "timeout"} you intend to {action}.
            </p>
            <div className="border-t border-slate-200 pt-3 dark:border-slate-800" />
            {jobName && (
              <p className="grid gap-1">
                <span>Original job name:</span>
                <span className="min-w-0 break-all font-mono text-xs text-slate-700 dark:text-slate-300">
                  {jobName}
                </span>
              </p>
            )}
            <div className="grid gap-1">
              <span>{isRetry ? "Retry jobs:" : "Resumed jobs:"}</span>
              {resumedJobs.isLoading ? (
                <InlineLoading />
              ) : resumedJobs.data?.length ? (
                <ul className="space-y-1">
                  {resumedJobs.data.map((job) => (
                    <li key={`${job.cluster}-${job.job_id}`} className="min-w-0 text-xs">
                      <Link
                        href={jobDetailHref(job.cluster, job.job_id)!}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[var(--ssot-accent)] hover:underline"
                      >
                        {job.job_id}
                      </Link>
                      <span className="text-slate-400"> · </span>
                      <span className="font-mono text-slate-700 dark:text-slate-300">
                        {job.state}
                      </span>
                      <span className="text-slate-400"> · </span>
                      <span className="break-all font-mono text-slate-700 dark:text-slate-300">
                        {job.job_name}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : resumedJobs.isError ? (
                <span className="text-xs text-red-600 dark:text-red-400">
                  Could not load resumed jobs.
                </span>
              ) : (
                <span className="font-mono text-xs text-[var(--ssot-text-soft)]">none</span>
              )}
            </div>
          </div>

          <div className="modal__foot">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={resume.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
            >
              {resume.isPending ? "Submitting..." : submitLabel}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
