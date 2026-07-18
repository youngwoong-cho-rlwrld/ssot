import { Matrix4, Vector3 } from "three";
import type { JointPose, PoseState, UrdfJoint, UrdfModel } from "./types";

const ZERO_XYZ: [number, number, number] = [0, 0, 0];
const DEFAULT_AXIS: [number, number, number] = [1, 0, 0];

type XmlElement = {
  attributes: Record<string, string>;
  body: string;
};

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(attributePattern)) {
    attributes[match[1]] = decodeXmlAttribute(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function extractElements(text: string, tagName: string): XmlElement[] {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>|<${tagName}\\b([^>]*)\\/\\s*>`, "g");
  return Array.from(text.matchAll(pattern), (match) => ({
    attributes: parseAttributes(match[1] ?? match[3] ?? ""),
    body: match[2] ?? "",
  }));
}

function parseTuple(value: string | null, fallback: [number, number, number]): [number, number, number] {
  if (!value) return fallback;
  const parsed = value
    .trim()
    .split(/\s+/)
    .map((token) => Number(token));
  if (parsed.length !== 3 || parsed.some((item) => Number.isNaN(item))) return fallback;
  return [parsed[0], parsed[1], parsed[2]];
}

function getRequiredAttribute(attributes: Record<string, string> | undefined, name: string, context: string): string {
  const value = attributes?.[name];
  if (!value) {
    throw new Error(`${context} is missing ${name}`);
  }
  return value;
}

export function parseUrdf(text: string): UrdfModel {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const robot = extractElements(xml, "robot")[0];
  if (!robot) throw new Error("URDF does not contain a robot element");

  const links = extractElements(robot.body, "link")
    .map((link) => link.attributes.name)
    .filter((name): name is string => Boolean(name));

  const joints: UrdfJoint[] = extractElements(robot.body, "joint").map((jointEl) => {
    const originEl = extractElements(jointEl.body, "origin")[0];
    const axisEl = extractElements(jointEl.body, "axis")[0];
    const mimicEl = extractElements(jointEl.body, "mimic")[0];
    const parentEl = extractElements(jointEl.body, "parent")[0];
    const childEl = extractElements(jointEl.body, "child")[0];
    const jointName = getRequiredAttribute(jointEl.attributes, "name", "URDF joint");

    const mimic = mimicEl
      ? {
          joint: getRequiredAttribute(mimicEl.attributes, "joint", `URDF joint ${jointName} mimic`),
          multiplier: Number(mimicEl.attributes.multiplier ?? 1),
          offset: Number(mimicEl.attributes.offset ?? 0),
        }
      : undefined;

    return {
      name: jointName,
      type: jointEl.attributes.type ?? "fixed",
      parent: getRequiredAttribute(parentEl?.attributes, "link", `URDF joint ${jointName} parent`),
      child: getRequiredAttribute(childEl?.attributes, "link", `URDF joint ${jointName} child`),
      originXyz: parseTuple(originEl?.attributes.xyz ?? null, ZERO_XYZ),
      originRpy: parseTuple(originEl?.attributes.rpy ?? null, ZERO_XYZ),
      axis: parseTuple(axisEl?.attributes.xyz ?? null, DEFAULT_AXIS),
      mimic,
    };
  });

  const childLinks = new Set(joints.map((joint) => joint.child));
  const rootLinks = links.filter((link) => !childLinks.has(link));
  const rootCandidates = rootLinks.length > 0 ? rootLinks : links.slice(0, 1);

  const childrenByParent = new Map<string, UrdfJoint[]>();
  joints.forEach((joint) => {
    const list = childrenByParent.get(joint.parent) ?? [];
    list.push(joint);
    childrenByParent.set(joint.parent, list);
  });

  const orderedJoints: UrdfJoint[] = [];
  const visitLink = (link: string) => {
    for (const joint of childrenByParent.get(link) ?? []) {
      orderedJoints.push(joint);
      visitLink(joint.child);
    }
  };
  rootCandidates.forEach(visitLink);

  const emitted = new Set(orderedJoints.map((joint) => joint.name));
  joints.forEach((joint) => {
    if (!emitted.has(joint.name)) orderedJoints.push(joint);
  });

  const jointsByName = new Map(joints.map((joint) => [joint.name, joint]));
  const incomingByChild = new Map(joints.map((joint) => [joint.child, joint.name]));
  const parentJointByName = new Map<string, string | null>();
  joints.forEach((joint) => {
    parentJointByName.set(joint.name, incomingByChild.get(joint.parent) ?? null);
  });

  return {
    name: robot.attributes.name ?? "robot",
    links,
    rootLinks: rootCandidates,
    joints,
    movableJoints: joints.filter((joint) => !["fixed", "floating", "planar"].includes(joint.type)),
    jointsByName,
    orderedJoints,
    parentJointByName,
  };
}

function originMatrix(joint: UrdfJoint): Matrix4 {
  const [x, y, z] = joint.originXyz;
  const [roll, pitch, yaw] = joint.originRpy;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);

  return new Matrix4().set(
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    x,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    y,
    -sp,
    cp * sr,
    cp * cr,
    z,
    0,
    0,
    0,
    1,
  );
}

function motionMatrix(joint: UrdfJoint, value: number): Matrix4 {
  const axis = new Vector3(...joint.axis);
  if (axis.lengthSq() === 0) axis.set(1, 0, 0);
  axis.normalize();

  if (joint.type === "revolute" || joint.type === "continuous") {
    return new Matrix4().makeRotationAxis(axis, value);
  }
  if (joint.type === "prismatic") {
    return new Matrix4().makeTranslation(axis.x * value, axis.y * value, axis.z * value);
  }
  return new Matrix4().identity();
}

function resolvedJointValue(joint: UrdfJoint, rawValues: Record<string, number>, resolved: Record<string, number>): number {
  if (rawValues[joint.name] !== undefined) return rawValues[joint.name];
  if (!joint.mimic) return 0;
  const parentValue = resolved[joint.mimic.joint] ?? rawValues[joint.mimic.joint] ?? 0;
  return parentValue * joint.mimic.multiplier + joint.mimic.offset;
}

export function computePose(model: UrdfModel, jointValues: Record<string, number>): PoseState {
  const linkMatrices = new Map<string, Matrix4>();
  const poses = new Map<string, JointPose>();
  const resolvedValues: Record<string, number> = {};

  model.rootLinks.forEach((link) => linkMatrices.set(link, new Matrix4().identity()));

  for (const joint of model.orderedJoints) {
    const parentMatrix = linkMatrices.get(joint.parent) ?? new Matrix4().identity();
    const value = resolvedJointValue(joint, jointValues, resolvedValues);
    resolvedValues[joint.name] = value;

    const baseMatrix = parentMatrix.clone().multiply(originMatrix(joint));
    const jointMatrix = baseMatrix.clone().multiply(motionMatrix(joint, value));
    const position = new Vector3().setFromMatrixPosition(jointMatrix);

    poses.set(joint.name, {
      name: joint.name,
      position,
      matrix: jointMatrix,
      value,
    });
    linkMatrices.set(joint.child, jointMatrix);
  }

  return { poses, linkMatrices };
}
