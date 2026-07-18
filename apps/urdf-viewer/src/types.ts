import type { Matrix4, Vector3 } from "three";

export type JointType = "fixed" | "revolute" | "continuous" | "prismatic" | "floating" | "planar" | string;

export type UrdfJoint = {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  originXyz: [number, number, number];
  originRpy: [number, number, number];
  axis: [number, number, number];
  mimic?: {
    joint: string;
    multiplier: number;
    offset: number;
  };
};

export type UrdfModel = {
  name: string;
  links: string[];
  rootLinks: string[];
  joints: UrdfJoint[];
  movableJoints: UrdfJoint[];
  jointsByName: Map<string, UrdfJoint>;
  orderedJoints: UrdfJoint[];
  parentJointByName: Map<string, string | null>;
};

export type JointPose = {
  name: string;
  position: Vector3;
  matrix: Matrix4;
  value: number;
};

export type PoseState = {
  poses: Map<string, JointPose>;
  linkMatrices: Map<string, Matrix4>;
};

export type MappingMode = "auto" | "named" | "state-vector" | "allex-48" | "openarm-xhand1-40";
export type NeckOrder = "carrier-yaw-pitch" | "urdf-pitch-yaw";

export type JointGroup = {
  id: string;
  name: string;
  color: string;
};

export type JointAppearance = {
  color: string;
  groupId: string;
  gizmo: boolean;
};

export type AssetSource = {
  urdfUrl: string;
  parquetUrl: string;
  urdfFile: File | null;
  parquetFile: File | null;
};
