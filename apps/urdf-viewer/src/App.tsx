import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FolderOpen, Pause, Play, Plus, Rotate3D, Settings, Trash2, Upload } from "lucide-react";
import { SceneView } from "./SceneView";
import { SsotSelect } from "@ssot/ui/SsotSelect";
import { COLOR_PALETTE_48, UNGROUPED_JOINT_COLOR, colorForIndex, normalizeHexColor } from "./colors";
import { availableColumns, detectMappingMode, isOpenarmXhand1Row, jointValuesForFrame, suggestedStateColumn } from "./mapping";
import { loadParquetRows, loadTextSource, type ParquetRow } from "./parquet";
import type { AssetSource, JointAppearance, JointGroup, MappingMode, NeckOrder, UrdfModel } from "./types";
import { computePose, parseUrdf } from "./urdf";

const asset = (path: string): string => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

const DEFAULT_URDF = asset("assets/default/allex.urdf");
const OPENARM_XHAND1_URDF = asset("assets/openarm-xhand1/openarm_xhand1.urdf");
const DEFAULT_PARQUET = asset("assets/default/episode_000000.parquet");
const PORTAL_URL = import.meta.env.VITE_SSOT_PORTAL_URL ?? "/";
const DEFAULT_STATE_COLUMN = "observation.state";
const INITIAL_FPS = 20;
const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 2, 5, 10] as const;
const NODE_SIZES = [0.25, 0.5, 0.75, 1, 2] as const;

const initialSource: AssetSource = {
  urdfUrl: DEFAULT_URDF,
  parquetUrl: DEFAULT_PARQUET,
  urdfFile: null,
  parquetFile: null,
};

type SavedGroupConfig = {
  version: 1;
  modelName: string | null;
  groups: JointGroup[];
  joints: Record<string, JointAppearance>;
  nodesByGroup: Record<string, string[]>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
}

function createGroupId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createUngroupedAppearance(gizmo = false): JointAppearance {
  return {
    color: UNGROUPED_JOINT_COLOR,
    groupId: "",
    gizmo,
  };
}

function sanitizeImportedGroups(rawGroups: unknown): { groups: JointGroup[]; groupIdMap: Map<string, string> } {
  if (!Array.isArray(rawGroups)) {
    throw new Error("Group config must include a groups array.");
  }

  const usedIds = new Set<string>();
  const groupIdMap = new Map<string, string>();
  const groups: JointGroup[] = [];

  rawGroups.forEach((rawGroup, index) => {
    if (!isRecord(rawGroup)) return;
    const name = typeof rawGroup.name === "string" ? rawGroup.name.trim() : "";
    if (!name) return;

    const rawId = typeof rawGroup.id === "string" && rawGroup.id.trim() ? rawGroup.id.trim() : createGroupId(name);
    let id = rawId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${rawId}-${suffix}`;
      suffix += 1;
    }

    usedIds.add(id);
    groupIdMap.set(rawId, id);
    groups.push({
      id,
      name,
      color: normalizeHexColor(typeof rawGroup.color === "string" ? rawGroup.color : "", colorForIndex(index)),
    });
  });

  return { groups, groupIdMap };
}

export function App() {
  const [source, setSource] = useState<AssetSource>(initialSource);
  const [model, setModel] = useState<UrdfModel | null>(null);
  const [rows, setRows] = useState<ParquetRow[]>([]);
  const [status, setStatus] = useState("Loading default assets");
  const [error, setError] = useState<string | null>(null);
  const [mappingMode, setMappingMode] = useState<MappingMode>("auto");
  const [neckOrder, setNeckOrder] = useState<NeckOrder>("carrier-yaw-pitch");
  const [stateColumn, setStateColumn] = useState(DEFAULT_STATE_COLUMN);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(INITIAL_FPS);
  const [playbackSpeed, setPlaybackSpeed] = useState<(typeof PLAYBACK_SPEEDS)[number]>(1);
  const [nodeSize, setNodeSize] = useState<(typeof NODE_SIZES)[number]>(1);
  const [showPlaybackSettings, setShowPlaybackSettings] = useState(false);
  const [hoveredJoint, setHoveredJoint] = useState<string | null>(null);
  const [jointFilter, setJointFilter] = useState("");
  const [groups, setGroups] = useState<JointGroup[]>([
    { id: "arms", name: "Arms", color: "#2671d9" },
    { id: "hands", name: "Hands", color: "#2f9d7e" },
  ]);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupColor, setNewGroupColor] = useState("#7c5ac7");
  const [appearances, setAppearances] = useState<Record<string, JointAppearance>>({});
  const [openColorJoint, setOpenColorJoint] = useState<string | null>(null);

  const jointRowRefs = useRef(new Map<string, HTMLDivElement>());
  const viewportRef = useRef<HTMLDivElement>(null);

  const loadAssets = useCallback(async () => {
    setStatus("Loading assets");
    setError(null);
    try {
      const parquetRows = await loadParquetRows(source.parquetFile ?? source.parquetUrl);
      const useOpenarmPreset = !source.urdfFile && source.urdfUrl === DEFAULT_URDF && isOpenarmXhand1Row(parquetRows[0]);
      const urdfUrl = useOpenarmPreset ? OPENARM_XHAND1_URDF : source.urdfUrl;
      const urdfText = await loadTextSource(source.urdfFile ?? urdfUrl);
      const parsed = parseUrdf(urdfText);
      setModel(parsed);
      setRows(parquetRows);
      setStateColumn(suggestedStateColumn(parquetRows[0]));
      if (useOpenarmPreset) {
        setSource((current) => ({ ...current, urdfUrl }));
      }
      setFrameIndex(0);
      setPlaying(false);
      setStatus(`${parsed.joints.length} joints · ${parquetRows.length} frames`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Load failed");
    }
  }, [source]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!model) return;
    setAppearances((current) => {
      const next: Record<string, JointAppearance> = {};
      model.orderedJoints.forEach((joint) => {
        next[joint.name] =
          current[joint.name] ??
          createUngroupedAppearance();
      });
      return next;
    });
  }, [model]);

  useEffect(() => {
    if (!playing || rows.length === 0) return;
    const delay = Math.max(16, 1000 / (fps * playbackSpeed));
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % rows.length);
    }, delay);
    return () => window.clearInterval(timer);
  }, [playing, rows.length, fps, playbackSpeed]);

  useEffect(() => {
    if (!hoveredJoint) return;
    jointRowRefs.current.get(hoveredJoint)?.scrollIntoView({ block: "nearest" });
  }, [hoveredJoint]);

  const columns = useMemo(() => availableColumns(rows[0]), [rows]);
  const currentRow = rows[frameIndex];
  const activeMapping = useMemo(() => {
    if (!model) return "state-vector";
    return mappingMode === "auto" ? detectMappingMode(model, currentRow, stateColumn) : mappingMode;
  }, [currentRow, mappingMode, model, stateColumn]);

  const pose = useMemo(() => {
    if (!model || !currentRow) return null;
    const values = jointValuesForFrame(model, currentRow, mappingMode, stateColumn, neckOrder);
    return computePose(model, values);
  }, [currentRow, mappingMode, model, neckOrder, stateColumn]);

  const filteredJoints = useMemo(() => {
    const query = jointFilter.trim().toLowerCase();
    if (!model) return [];
    if (!query) return model.orderedJoints;
    return model.orderedJoints.filter((joint) => joint.name.toLowerCase().includes(query) || joint.type.toLowerCase().includes(query));
  }, [jointFilter, model]);

  const allJointGizmosEnabled = useMemo(() => {
    if (!model || model.orderedJoints.length === 0) return false;
    return model.orderedJoints.every((joint) => appearances[joint.name]?.gizmo);
  }, [appearances, model]);

  const stepOption = <T extends readonly number[]>(options: T, value: T[number], direction: -1 | 1): T[number] => {
    const index = options.indexOf(value);
    const nextIndex = clamp(index + direction, 0, options.length - 1);
    return options[nextIndex] as T[number];
  };

  const updateAppearance = (jointName: string, patch: Partial<JointAppearance>) => {
    setAppearances((current) => ({
      ...current,
      [jointName]: {
        ...(current[jointName] ?? createUngroupedAppearance()),
        ...patch,
      },
    }));
  };

  const assignJointGroup = (jointName: string, groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    updateAppearance(jointName, {
      groupId,
      color: group ? group.color : UNGROUPED_JOINT_COLOR,
    });
  };

  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    setGroups((current) => [...current, { id: createGroupId(name), name, color: normalizeHexColor(newGroupColor, "#7c5ac7") }]);
    setNewGroupName("");
  };

  const removeGroup = (groupId: string) => {
    setGroups((current) => current.filter((group) => group.id !== groupId));
    setAppearances((current) => {
      const next = { ...current };
      Object.entries(next).forEach(([jointName, appearance]) => {
        if (appearance.groupId === groupId) {
          next[jointName] = { ...appearance, color: UNGROUPED_JOINT_COLOR, groupId: "" };
        }
      });
      return next;
    });
  };

  const saveGroupConfig = () => {
    const jointNames = model ? model.orderedJoints.map((joint) => joint.name) : Object.keys(appearances).sort();
    const joints = jointNames.reduce<Record<string, JointAppearance>>((acc, jointName) => {
      acc[jointName] = appearances[jointName] ?? createUngroupedAppearance();
      return acc;
    }, {});
    const nodesByGroup = groups.reduce<Record<string, string[]>>((acc, group) => {
      acc[group.id] = jointNames.filter((jointName) => joints[jointName]?.groupId === group.id);
      return acc;
    }, {});
    const config: SavedGroupConfig = {
      version: 1,
      modelName: model?.name ?? null,
      groups,
      joints,
      nodesByGroup,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${model?.name ?? "urdf"}-joint-groups.json`);
  };

  const applyGroupConfig = (parsed: unknown, statusLabel?: string) => {
    if (!isRecord(parsed)) {
      throw new Error("Group config must be a JSON object.");
    }

    const { groups: importedGroups, groupIdMap } = sanitizeImportedGroups(parsed.groups);
    const validGroupIds = new Set(importedGroups.map((group) => group.id));
    const knownJointNames = model ? new Set(model.orderedJoints.map((joint) => joint.name)) : null;
    const nextAppearances: Record<string, JointAppearance> = {};

    if (model) {
      model.orderedJoints.forEach((joint) => {
        nextAppearances[joint.name] = appearances[joint.name] ?? createUngroupedAppearance();
      });
    } else {
      Object.assign(nextAppearances, appearances);
    }

    if (isRecord(parsed.joints)) {
      Object.entries(parsed.joints).forEach(([jointName, rawAppearance]) => {
        if (knownJointNames && !knownJointNames.has(jointName)) return;
        if (!isRecord(rawAppearance)) return;

        const current = nextAppearances[jointName] ?? createUngroupedAppearance();
        const rawGroupId = typeof rawAppearance.groupId === "string" ? rawAppearance.groupId : "";
        const mappedGroupId = rawGroupId ? groupIdMap.get(rawGroupId) ?? rawGroupId : "";
        nextAppearances[jointName] = {
          color: normalizeHexColor(typeof rawAppearance.color === "string" ? rawAppearance.color : "", current.color),
          groupId: validGroupIds.has(mappedGroupId) ? mappedGroupId : "",
          gizmo: typeof rawAppearance.gizmo === "boolean" ? rawAppearance.gizmo : current.gizmo,
        };
      });
    }

    if (isRecord(parsed.nodesByGroup)) {
      Object.entries(parsed.nodesByGroup).forEach(([rawGroupId, rawJointNames]) => {
        const groupId = groupIdMap.get(rawGroupId) ?? rawGroupId;
        if (!validGroupIds.has(groupId) || !Array.isArray(rawJointNames)) return;
        rawJointNames.forEach((rawJointName) => {
          if (typeof rawJointName !== "string") return;
          if (knownJointNames && !knownJointNames.has(rawJointName)) return;
          const current = nextAppearances[rawJointName] ?? createUngroupedAppearance();
          nextAppearances[rawJointName] = { ...current, groupId };
        });
      });
    }

    setGroups(importedGroups);
    setAppearances(nextAppearances);
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : null;
    if (metadata?.neckOrder === "carrier-yaw-pitch" || metadata?.neckOrder === "urdf-pitch-yaw") {
      setNeckOrder(metadata.neckOrder);
    }
    setStatus(statusLabel ? `Loaded ${statusLabel}` : `Loaded ${importedGroups.length} groups`);
  };

  const loadGroupConfig = async (file: File | null) => {
    if (!file) return;
    setError(null);
    try {
      applyGroupConfig(JSON.parse(await file.text()) as unknown, file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Group config load failed");
    }
  };

  const setAllJointGizmos = (enabled: boolean) => {
    setAppearances((current) => {
      const next: Record<string, JointAppearance> = {};
      Object.entries(current).forEach(([name, appearance]) => {
        next[name] = { ...appearance, gizmo: enabled };
      });
      return next;
    });
  };

  const stepFrame = (delta: number) => {
    if (rows.length === 0) return;
    setFrameIndex((current) => clamp(current + delta, 0, rows.length - 1));
  };

  const saveViewportImage = () => {
    const canvas = viewportRef.current?.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) {
      setError("Viewport canvas is not available.");
      return;
    }

    canvas.toBlob((blob) => {
      if (!blob) {
        setError("Could not save viewport image.");
        return;
      }
      const frameLabel = rows.length > 0 ? `frame-${String(frameIndex + 1).padStart(6, "0")}` : "view";
      downloadBlob(blob, `${model?.name ?? "urdf"}-${frameLabel}.png`);
    }, "image/png");
  };

  return (
    <div className="ssot-app app-root">
      <header className="ssot-header">
        <a className="ssot-brand" href={PORTAL_URL}>SSOT</a>
        <span className="ssot-sep">/</span>
        <span className="ssot-app-name">URDF Viewer</span>
        <span className="ssot-header-spacer" />
        <ssot-theme-toggle></ssot-theme-toggle>
        <ssot-user></ssot-user>
      </header>
      <main className="app-shell">
      <aside className="source-panel">
        <div className="panel-header">
          <span className={error ? "status status-error" : "status"}>{status}</span>
        </div>

        <section className="panel-section">
          <div className="section-title">
            <FolderOpen size={16} />
            <span>Assets</span>
          </div>
          <div className="field">
            <span>URDF path</span>
            <div className="path-row">
              <input
                className="u-input"
                value={source.urdfFile ? source.urdfFile.name : source.urdfUrl}
                onChange={(event) => setSource((current) => ({ ...current, urdfUrl: event.target.value, urdfFile: null }))}
              />
              <label className="u-btn choose-btn" title="Choose URDF" aria-label="Choose URDF">
                <Upload size={16} />
                <input
                  type="file"
                  accept=".urdf,.xml,text/xml"
                  onChange={(event) => setSource((current) => ({ ...current, urdfFile: event.target.files?.[0] ?? null }))}
                />
              </label>
            </div>
          </div>

          <div className="field">
            <span>Parquet path</span>
            <div className="path-row">
              <input
                className="u-input"
                value={source.parquetFile ? source.parquetFile.name : source.parquetUrl}
                onChange={(event) => setSource((current) => ({ ...current, parquetUrl: event.target.value, parquetFile: null }))}
              />
              <label className="u-btn choose-btn" title="Choose parquet" aria-label="Choose parquet">
                <Upload size={16} />
                <input
                  type="file"
                  accept=".parquet"
                  onChange={(event) => setSource((current) => ({ ...current, parquetFile: event.target.files?.[0] ?? null }))}
                />
              </label>
            </div>
          </div>
          {error && <div className="error-box">{error}</div>}
        </section>

        <section className="panel-section">
          <div className="section-title">
            <Rotate3D size={16} />
            <span>Mapping</span>
          </div>
          <div className="field">
            <span>Mode</span>
            <SsotSelect
              aria-label="Mapping mode"
              value={mappingMode}
              onChange={(value) => setMappingMode(value as MappingMode)}
              options={[
                { value: "auto", label: `Auto (${activeMapping})` },
                { value: "named", label: "Named columns" },
                { value: "state-vector", label: "State vector" },
                { value: "allex-48", label: "ALLEX obs48" },
                { value: "openarm-xhand1-40", label: "OpenArm + XHand1 obs40" },
              ]}
            />
          </div>
          <label className="field">
            <span>State column</span>
            <input className="u-input" list="parquet-columns" value={stateColumn} onChange={(event) => setStateColumn(event.target.value)} />
          </label>
          {activeMapping === "openarm-xhand1-40" ? (
            <div className="field">
              <span>Head order</span>
              <div className="mapping-readout">0 pitch · 1 yaw</div>
            </div>
          ) : activeMapping === "allex-48" ? (
            <div className="field">
              <span>Neck order</span>
              <SsotSelect
                aria-label="Neck order"
                value={neckOrder}
                onChange={(value) => setNeckOrder(value as NeckOrder)}
                options={[
                  { value: "carrier-yaw-pitch", label: "Carrier: 44 yaw, 45 pitch" },
                  { value: "urdf-pitch-yaw", label: "URDF/export: 44 pitch, 45 yaw" },
                ]}
              />
            </div>
          ) : null}
          <datalist id="parquet-columns">
            {columns.map((column) => (
              <option key={column} value={column} />
            ))}
          </datalist>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <Plus size={16} />
            <span>Groups</span>
          </div>
          <div className="group-create">
            <input className="u-input" value={newGroupName} placeholder="Group name" onChange={(event) => setNewGroupName(event.target.value)} />
            <input className="u-input-color" type="color" value={newGroupColor} onChange={(event) => setNewGroupColor(event.target.value)} />
            <button className="u-btn" type="button" title="Create group" onClick={addGroup}>
              <Plus size={16} />
            </button>
          </div>
          <div className="config-actions">
            <button type="button" className="u-btn config-action" onClick={saveGroupConfig}>
              <Download size={15} />
              <span>Save</span>
            </button>
            <label className="config-action">
              <Upload size={15} />
              <span>Load</span>
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const input = event.currentTarget;
                  void loadGroupConfig(input.files?.[0] ?? null).finally(() => {
                    input.value = "";
                  });
                }}
              />
            </label>
          </div>
          <div className="group-list">
            {groups.map((group) => (
              <div className="group-row" key={group.id}>
                <span className="swatch" style={{ background: group.color }} />
                <span>{group.name}</span>
                <button className="u-btn" type="button" title="Remove group" onClick={() => removeGroup(group.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <section className="viewport-panel">
        <div className="viewport-stage" ref={viewportRef}>
          <button
            className="u-btn viewport-save-button"
            type="button"
            title="Save viewport image"
            disabled={!model || !pose}
            onClick={saveViewportImage}
          >
            <Download size={16} />
          </button>
          <SceneView
            model={model}
            pose={pose}
            appearances={appearances}
            hoveredJoint={hoveredJoint}
            setHoveredJoint={setHoveredJoint}
            nodeSize={nodeSize}
          />
        </div>
        <div className="transport">
          <button className="u-btn transport-circle" type="button" title="Previous frame" onClick={() => stepFrame(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button type="button" className="u-btn transport-circle play-button" title={playing ? "Pause" : "Play"} onClick={() => setPlaying((current) => !current)}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button className="u-btn transport-circle" type="button" title="Next frame" onClick={() => stepFrame(1)}>
            <ChevronRight size={18} />
          </button>
          <input
            className="u-input-range frame-slider"
            type="range"
            min={0}
            max={Math.max(0, rows.length - 1)}
            value={frameIndex}
            onChange={(event) => setFrameIndex(Number(event.target.value))}
          />
          <span className="frame-readout">
            {rows.length === 0 ? "0 / 0" : `${frameIndex + 1} / ${rows.length}`}
          </span>
          <div className="playback-settings">
            <button
              className={showPlaybackSettings ? "u-btn settings-button active" : "u-btn settings-button"}
              type="button"
              title="Playback settings"
              aria-expanded={showPlaybackSettings}
              onClick={() => setShowPlaybackSettings((current) => !current)}
            >
              <Settings size={17} />
            </button>
            {showPlaybackSettings && (
              <div className="settings-popover">
                <label className="settings-fps">
                  <span>FPS</span>
                  <input
                    className="u-input"
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    value={fps}
                    onChange={(event) => setFps(clamp(Number(event.target.value) || INITIAL_FPS, 1, 240))}
                  />
                </label>
                <div className="settings-stepper">
                  <div className="settings-title">Playback speed</div>
                  <div className="stepper-control">
                    <button
                      className="u-btn"
                      type="button"
                      title="Slower"
                      disabled={playbackSpeed === PLAYBACK_SPEEDS[0]}
                      onClick={() => setPlaybackSpeed(stepOption(PLAYBACK_SPEEDS, playbackSpeed, -1))}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>{playbackSpeed}x</span>
                    <button
                      className="u-btn"
                      type="button"
                      title="Faster"
                      disabled={playbackSpeed === PLAYBACK_SPEEDS[PLAYBACK_SPEEDS.length - 1]}
                      onClick={() => setPlaybackSpeed(stepOption(PLAYBACK_SPEEDS, playbackSpeed, 1))}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
                <div className="settings-stepper">
                  <div className="settings-title">Node size</div>
                  <div className="stepper-control">
                    <button
                      className="u-btn"
                      type="button"
                      title="Smaller nodes"
                      disabled={nodeSize === NODE_SIZES[0]}
                      onClick={() => setNodeSize(stepOption(NODE_SIZES, nodeSize, -1))}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>{nodeSize}x</span>
                    <button
                      className="u-btn"
                      type="button"
                      title="Larger nodes"
                      disabled={nodeSize === NODE_SIZES[NODE_SIZES.length - 1]}
                      onClick={() => setNodeSize(stepOption(NODE_SIZES, nodeSize, 1))}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <aside className="joint-panel">
        <div className="joint-toolbar">
          <div>
            <h2>Joints</h2>
            <span>{model ? `${model.orderedJoints.length} total` : "No URDF"}</span>
          </div>
          <button
            type="button"
            className={allJointGizmosEnabled ? "u-btn gizmo-toggle active" : "u-btn gizmo-toggle"}
            title={allJointGizmosEnabled ? "Hide all joint axes" : "Show all joint axes"}
            onClick={() => setAllJointGizmos(!allJointGizmosEnabled)}
          >
            <Rotate3D size={16} />
          </button>
        </div>
        <div className="bulk-row">
          <input className="u-input" value={jointFilter} placeholder="Filter joints" onChange={(event) => setJointFilter(event.target.value)} />
        </div>

        <div className="joint-list">
          {filteredJoints.map((joint) => {
            const appearance = appearances[joint.name] ?? createUngroupedAppearance();
            const group = groups.find((item) => item.id === appearance.groupId);
            return (
              <div
                key={joint.name}
                ref={(node) => {
                  if (node) jointRowRefs.current.set(joint.name, node);
                  else jointRowRefs.current.delete(joint.name);
                }}
                className={hoveredJoint === joint.name ? "joint-row hovered" : "joint-row"}
                onMouseEnter={() => setHoveredJoint(joint.name)}
                onMouseLeave={() => setHoveredJoint(null)}
              >
                <div className="joint-main">
                  <div className="joint-color-cell">
                    <button
                      type="button"
                      className="u-btn joint-dot"
                      style={{ background: appearance.color }}
                      title="Change joint color"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenColorJoint((current) => (current === joint.name ? null : joint.name));
                      }}
                    />
                    {openColorJoint === joint.name && (
                      <div className="color-popover">
                        {COLOR_PALETTE_48.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={appearance.color.toLowerCase() === color.toLowerCase() ? "u-btn color-swatch active" : "u-btn color-swatch"}
                            style={{ background: color }}
                            title={color}
                            onClick={(event) => {
                              event.stopPropagation();
                              updateAppearance(joint.name, { color });
                              setOpenColorJoint(null);
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="joint-name-line">
                      <div className="joint-name">{joint.name}</div>
                      <button
                        type="button"
                        className={appearance.gizmo ? "u-btn gizmo-toggle active" : "u-btn gizmo-toggle"}
                        title={appearance.gizmo ? "Hide joint gizmo" : "Show joint gizmo"}
                        onClick={() => updateAppearance(joint.name, { gizmo: !appearance.gizmo })}
                      >
                        <Rotate3D size={15} />
                      </button>
                    </div>
                    <div className="joint-meta">
                      {joint.type}
                      {group ? ` · ${group.name}` : ""}
                    </div>
                  </div>
                </div>
                <div className="joint-controls">
                  <SsotSelect
                    variant="pill"
                    className="joint-group-select"
                    aria-label={`Group for ${joint.name}`}
                    value={appearance.groupId}
                    onChange={(value) => assignJointGroup(joint.name, value)}
                    options={[
                      { value: "", label: "Ungrouped" },
                      ...groups.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </aside>
      </main>
    </div>
  );
}
