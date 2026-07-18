"use client";

import { type ReactNode, use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import {
  api,
  type ExperimentFiles,
  type SaveExperimentFilesResponse,
  type Variant,
} from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/loading-state";
import {
  ConfigKeyValueView,
  ConfigViewToggle,
  type ConfigViewMode,
  YamlTreeView,
} from "@/components/experiment-config-view";

export default function ExperimentDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const files = useQuery({
    queryKey: ["experiment-files", name],
    queryFn: () => api<ExperimentFiles>(`/api/variants/${encodeURIComponent(name)}/files`),
  });

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <Link
        href="/experiments"
        className="inline-flex items-center gap-1 text-sm text-[var(--ssot-text-soft)] transition-colors hover:text-slate-900 dark:hover:text-slate-50"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to experiments
      </Link>

      <h1 className="mt-4 font-mono text-xl font-semibold tracking-tight">{name}</h1>

      <div className="mt-6">
        {files.isLoading && <LoadingState label="Loading experiment files..." rows={8} />}
        {files.error && <ErrorState message={(files.error as Error).message} />}
        {files.data && <ExperimentFilesEditor name={name} files={files.data} />}
      </div>
    </div>
  );
}

function ExperimentFilesEditor({
  name,
  files,
}: {
  name: string;
  files: ExperimentFiles;
}) {
  const qc = useQueryClient();
  const [configTitle, setConfigTitle] = useState(files.config.title);
  const [configContent, setConfigContent] = useState(files.config.content);
  const [secondTitle, setSecondTitle] = useState(files.second_file.title);
  const [secondContent, setSecondContent] = useState(files.second_file.content);
  const [configView, setConfigView] = useState<ConfigViewMode>("ui");
  const [secondView, setSecondView] = useState<ConfigViewMode>("ui");

  // Parsed vars/arrays for the config.sh UI view. Reuses the server-side bash
  // parse (/api/variants/<name>) so we never re-parse shell in the browser; the
  // save/restore handlers below invalidate this key, so it refreshes on save.
  const parsed = useQuery({
    queryKey: ["variant", name],
    queryFn: () => api<Variant>(`/api/variants/${encodeURIComponent(name)}`),
  });

  const save = useMutation({
    mutationFn: () =>
      api<SaveExperimentFilesResponse>(`/api/variants/${encodeURIComponent(name)}/files`, {
        method: "PUT",
        body: JSON.stringify({
          config_title: configTitle,
          config_content: configContent,
          second_title: secondTitle,
          second_content: secondContent,
        }),
      }),
    onSuccess: (res) => {
      setConfigTitle(res.config.title);
      setConfigContent(res.config.content);
      setSecondTitle(res.second_file.title);
      setSecondContent(res.second_file.content);
      qc.setQueryData(["experiment-files", name], res);
      qc.invalidateQueries({ queryKey: ["variant", name] });
      qc.invalidateQueries({ queryKey: ["variant-data-interface", name] });
      toast.success(res.saved_version_path ? "Saved files and archived previous version" : "Files unchanged");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const restore = useMutation({
    mutationFn: (version: string) =>
      api<SaveExperimentFilesResponse>(
        `/api/variants/${name}/files/versions/${encodeURIComponent(version)}/restore`,
        { method: "POST" },
      ),
    onSuccess: (res) => {
      setConfigTitle(res.config.title);
      setConfigContent(res.config.content);
      setSecondTitle(res.second_file.title);
      setSecondContent(res.second_file.content);
      qc.setQueryData(["experiment-files", name], res);
      qc.invalidateQueries({ queryKey: ["variant", name] });
      qc.invalidateQueries({ queryKey: ["variant-data-interface", name] });
      toast.success("Restored previous version");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dirty =
    configTitle !== files.config.title ||
    configContent !== files.config.content ||
    secondTitle !== files.second_file.title ||
    secondContent !== files.second_file.content;
  const configDirty = configContent !== files.config.content;
  const configTitleValid = configTitle.trim() === "config.sh";
  // config.sh gets a shell key-value view; YAML second files get a parsed tree;
  // modality.py stays code-only (no structured view).
  const secondIsYaml = files.second_file.kind.endsWith("_yaml");

  function updateSecondTitle(next: string) {
    setSecondTitle(next);
    if (next.trim()) {
      setConfigContent((current) =>
        rewriteSecondFileRef(current, next.trim(), files.second_file.kind),
      );
    }
  }

  function restoreVersion(version: string) {
    const message = dirty
      ? "Restore this previous version and discard unsaved edits? The current files will be archived first."
      : "Restore this previous version? The current files will be archived first.";
    if (!window.confirm(message)) return;
    restore.mutate(version);
  }

  const configUiView = parsed.isLoading ? (
    <LoadingState label="Parsing config.sh..." rows={4} />
  ) : parsed.error ? (
    <ErrorState message={(parsed.error as Error).message} />
  ) : parsed.data ? (
    <div className="space-y-3">
      {configDirty && (
        <p className="text-xs text-slate-400">
          Showing the last saved config.sh. Switch to Code to review unsaved edits.
        </p>
      )}
      <ConfigKeyValueView
        raw={parsed.data.raw}
        vars={parsed.data.vars}
        arrays={parsed.data.arrays}
      />
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <VersionList
          versions={files.versions}
          restoringVersion={restore.isPending ? restore.variables : undefined}
          onRestore={restoreVersion}
        />
        <Button
          onClick={() => save.mutate()}
          disabled={!dirty || !configTitleValid || save.isPending || restore.isPending}
        >
          {save.isPending ? "Saving..." : "Save files"}
        </Button>
      </div>

      <FileCard
        label={files.config.label}
        purpose={files.config.purpose}
        title={configTitle}
        titleInvalid={!configTitleValid}
        path={files.config.path}
        content={configContent}
        onTitleChange={setConfigTitle}
        onContentChange={setConfigContent}
        view={{ mode: configView, onModeChange: setConfigView, uiContent: configUiView }}
      />
      <FileCard
        label={files.second_file.label}
        purpose={files.second_file.purpose}
        title={secondTitle}
        path={files.second_file.path}
        content={secondContent}
        onTitleChange={updateSecondTitle}
        onContentChange={setSecondContent}
        view={
          secondIsYaml
            ? {
                mode: secondView,
                onModeChange: setSecondView,
                uiContent: <YamlTreeView text={secondContent} />,
              }
            : undefined
        }
      />
    </div>
  );
}

function FileCard({
  label,
  purpose,
  title,
  titleInvalid = false,
  path,
  content,
  onTitleChange,
  onContentChange,
  view,
}: {
  label: string;
  purpose: string;
  title: string;
  titleInvalid?: boolean;
  path: string;
  content: string;
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  // When set, a UI/Code toggle is shown; UI renders `uiContent` read-only and
  // Code renders the editable title + textarea (the editing surface).
  view?: {
    mode: ConfigViewMode;
    onModeChange: (mode: ConfigViewMode) => void;
    uiContent: ReactNode;
  };
}) {
  const showUi = view && view.mode === "ui";
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle>{label}</CardTitle>
            <p className="text-sm text-slate-600 dark:text-slate-400">{purpose}</p>
            <CardDescription className="font-mono text-xs">{path}</CardDescription>
          </div>
          {view && <ConfigViewToggle mode={view.mode} onChange={view.onModeChange} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showUi ? (
          view.uiContent
        ) : (
          <>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                className={
                  titleInvalid
                    ? "font-mono text-xs border-red-500 focus-visible:ring-red-500"
                    : "font-mono text-xs"
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Content</Label>
              <textarea
                value={content}
                onChange={(e) => onContentChange(e.target.value)}
                spellCheck={false}
                className="min-h-[28rem] w-full resize-y rounded-md border border-[var(--ssot-border-strong)] bg-[var(--ssot-surface)] p-3 font-mono text-xs leading-relaxed outline-none transition-colors focus-visible:border-[var(--ssot-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ssot-ring)]"
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VersionList({
  versions,
  restoringVersion,
  onRestore,
}: {
  versions: ExperimentFiles["versions"];
  restoringVersion?: string;
  onRestore: (version: string) => void;
}) {
  if (versions.length === 0) {
    return <EmptyState message="No previous file versions." />;
  }
  return (
    <div className="min-w-0 text-xs text-[var(--ssot-text-soft)]">
      <div className="mb-1 font-medium uppercase tracking-wide">Previous versions</div>
      <ul className="space-y-1">
        {versions.slice(0, 5).map((version) => (
          <li
            key={version.path}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
          >
            <span className="font-mono">{version.created_at}</span>
            <span className="min-w-0 font-mono text-slate-400">
              {version.files.join(", ")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onRestore(version.created_at)}
              disabled={restoringVersion === version.created_at}
            >
              {restoringVersion === version.created_at ? "Restoring..." : "Restore"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function rewriteSecondFileRef(config: string, title: string, kind: string) {
  const key = kind === "data_config_yaml" ? "TRAIN_DATA_CONFIG" : "TRAIN_MODALITY_CONFIG";
  const line = `${key}=${title}`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}=.*$`, "m");
  if (pattern.test(config)) return config.replace(pattern, line);
  const suffix = config.endsWith("\n") ? "" : "\n";
  return `${config}${suffix}\n${line}\n`;
}
