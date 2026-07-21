import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Line, OrbitControls } from "@react-three/drei";
import { Box3, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Sphere, Vector3 } from "three";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { UNGROUPED_JOINT_COLOR } from "./colors";
import type { JointAppearance, PoseState, UrdfModel } from "./types";

type SceneViewProps = {
  model: UrdfModel | null;
  pose: PoseState | null;
  appearances: Record<string, JointAppearance>;
  hoveredJoint: string | null;
  setHoveredJoint: (name: string | null) => void;
  nodeSize: number;
};

type OrbitControlsRef = OrbitControlsImpl | null;

type SceneColors = {
  background: string;
  gridMajor: string;
  gridMinor: string;
  edge: string;
  label: string;
};

const LIGHT_SCENE_COLORS: SceneColors = {
  background: "#f7f8fa",
  gridMajor: "#d6dbe3",
  gridMinor: "#eef1f5",
  edge: "#8e99a8",
  label: "#111827",
};

const DARK_SCENE_COLORS: SceneColors = {
  background: "#111318",
  gridMajor: "#2b3140",
  gridMinor: "#1c2029",
  edge: "#6b7688",
  label: "#e5e7eb",
};

// Mirror the shared theme (html[data-ssot-theme]) into the WebGL scene, which
// cannot read CSS custom properties directly.
function useSceneColors(): SceneColors {
  const [dark, setDark] = useState<boolean>(() =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-ssot-theme") === "dark",
  );

  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.getAttribute("data-ssot-theme") === "dark");
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ["data-ssot-theme"] });
    return () => observer.disconnect();
  }, []);

  return dark ? DARK_SCENE_COLORS : LIGHT_SCENE_COLORS;
}

function AutoFrame({
  model,
  pose,
  controlsRef,
}: {
  model: UrdfModel | null;
  pose: PoseState | null;
  controlsRef: MutableRefObject<OrbitControlsRef>;
}) {
  const framedModelRef = useRef<UrdfModel | null>(null);

  useEffect(() => {
    if (!model || !pose || framedModelRef.current === model) return;
    const points = Array.from(pose.poses.values(), (jointPose) => jointPose.position);
    if (points.length === 0) return;

    const box = new Box3().setFromPoints(points);
    const center = box.getCenter(new Vector3());
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(0.18, sphere.radius);
    const controls = controlsRef.current;
    if (!controls) return;
    const camera = controls.object as PerspectiveCamera | OrthographicCamera;

    const direction = new Vector3(1.15, 1.15, 0.82).normalize();
    const fov = "fov" in camera ? camera.fov * (Math.PI / 180) : Math.PI / 4;
    const distance = (radius * 1.28) / Math.sin(fov / 2);

    camera.up.set(0, 0, 1);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.001, distance / 100);
    camera.far = Math.max(100, distance * 100);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    framedModelRef.current = model;
  }, [controlsRef, model, pose]);

  return null;
}

function matrixParts(matrix: Matrix4) {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion };
}

function AxisGizmo({ matrix, size = 0.045 }: { matrix: Matrix4; size?: number }) {
  const { position, quaternion } = useMemo(() => matrixParts(matrix), [matrix]);
  return (
    <group position={position} quaternion={quaternion}>
      <Line points={[new Vector3(0, 0, 0), new Vector3(size, 0, 0)]} color="#e5484d" lineWidth={2} />
      <Line points={[new Vector3(0, 0, 0), new Vector3(0, size, 0)]} color="#2f9e44" lineWidth={2} />
      <Line points={[new Vector3(0, 0, 0), new Vector3(0, 0, size)]} color="#1c7ed6" lineWidth={2} />
    </group>
  );
}

function JointPoint({
  name,
  position,
  color,
  isHovered,
  setHoveredJoint,
  nodeSize,
}: {
  name: string;
  position: Vector3;
  color: string;
  isHovered: boolean;
  setHoveredJoint: (name: string | null) => void;
  nodeSize: number;
}) {
  const onPointerOver = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHoveredJoint(name);
  };
  const onPointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHoveredJoint(null);
  };

  return (
    <mesh position={position} onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
      <sphereGeometry args={[(isHovered ? 0.0136 : 0.0088) * nodeSize, 18, 18]} />
      <meshBasicMaterial color={isHovered ? "#f5c542" : color} />
    </mesh>
  );
}

function CoordinateLabel({ name, position }: { name: string; position: Vector3 }) {
  return (
    <div className="coordinate-label">
      <strong>{name}</strong>
      <span>
        {position.x.toFixed(4)}, {position.y.toFixed(4)}, {position.z.toFixed(4)} m
      </span>
    </div>
  );
}

type RobotSkeletonProps = {
  model: NonNullable<SceneViewProps["model"]>;
  pose: NonNullable<SceneViewProps["pose"]>;
  appearances: SceneViewProps["appearances"];
  hoveredJoint: SceneViewProps["hoveredJoint"];
  setHoveredJoint: SceneViewProps["setHoveredJoint"];
  nodeSize: SceneViewProps["nodeSize"];
  edgeColor: string;
};

function RobotSkeleton({
  model,
  pose,
  appearances,
  hoveredJoint,
  setHoveredJoint,
  nodeSize,
  edgeColor,
}: RobotSkeletonProps) {
  return (
    <>
      {model.orderedJoints.map((joint) => {
        const parentName = model.parentJointByName.get(joint.name);
        const jointPose = pose.poses.get(joint.name);
        const parentPose = parentName ? pose.poses.get(parentName) : null;
        if (!jointPose || !parentPose) return null;
        return <Line key={`${joint.name}:edge`} points={[parentPose.position, jointPose.position]} color={edgeColor} lineWidth={1.2} />;
      })}

      {model.orderedJoints.map((joint) => {
        const jointPose = pose.poses.get(joint.name);
        if (!jointPose) return null;
        const appearance = appearances[joint.name];
        return (
          <JointPoint
            key={joint.name}
            name={joint.name}
            position={jointPose.position}
            color={appearance?.color ?? UNGROUPED_JOINT_COLOR}
            isHovered={hoveredJoint === joint.name}
            setHoveredJoint={setHoveredJoint}
            nodeSize={nodeSize}
          />
        );
      })}

      {model.orderedJoints.map((joint) => {
        const jointPose = pose.poses.get(joint.name);
        if (!jointPose || !appearances[joint.name]?.gizmo) return null;
        return <AxisGizmo key={`${joint.name}:gizmo`} matrix={jointPose.matrix} />;
      })}
    </>
  );
}

export function SceneView({ model, pose, appearances, hoveredJoint, setHoveredJoint, nodeSize }: SceneViewProps) {
  const controlsRef = useRef<OrbitControlsRef>(null);
  const hoveredPose = hoveredJoint ? pose?.poses.get(hoveredJoint) : null;
  const colors = useSceneColors();

  return (
    <>
      <Canvas
        camera={{ position: [1.1, -1.65, 1.05], fov: 45, near: 0.01, far: 100 }}
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        onCreated={({ camera }) => {
          camera.up.set(0, 0, 1);
        }}
      >
        <color attach="background" args={[colors.background]} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[2, -3, 4]} intensity={1.2} />
        <gridHelper args={[2.4, 24, colors.gridMajor, colors.gridMinor]} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.001]} />
        <axesHelper args={[0.25]} />
        {model && pose && (
          <RobotSkeleton
            model={model}
            pose={pose}
            appearances={appearances}
            hoveredJoint={hoveredJoint}
            setHoveredJoint={setHoveredJoint}
            nodeSize={nodeSize}
            edgeColor={colors.edge}
          />
        )}
        <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
        <AutoFrame model={model} pose={pose} controlsRef={controlsRef} />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={["#e5484d", "#2f9e44", "#1c7ed6"]} labelColor={colors.label} />
        </GizmoHelper>
      </Canvas>
      {hoveredPose && <CoordinateLabel name={hoveredPose.name} position={hoveredPose.position} />}
    </>
  );
}
