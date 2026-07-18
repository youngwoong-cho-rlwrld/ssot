import type { NeckOrder } from "./types";

export const ALLEX_STATE_SIZE = 48;

export const ALLEX_ARM_JOINTS = [
  "R_Shoulder_Pitch_Joint",
  "R_Shoulder_Roll_Joint",
  "R_Shoulder_Yaw_Joint",
  "R_Elbow_Joint",
  "R_Wrist_Yaw_Joint",
  "R_Wrist_Roll_Joint",
  "R_Wrist_Pitch_Joint",
  "L_Shoulder_Pitch_Joint",
  "L_Shoulder_Roll_Joint",
  "L_Shoulder_Yaw_Joint",
  "L_Elbow_Joint",
  "L_Wrist_Yaw_Joint",
  "L_Wrist_Roll_Joint",
  "L_Wrist_Pitch_Joint",
] as const;

export const ALLEX_HAND_20_SUFFIX = [
  "Thumb_Yaw_Joint",
  "Thumb_CMC_Joint",
  "Thumb_MCP_Joint",
  "Thumb_IP_Joint",
  "Index_Roll_Joint",
  "Index_MCP_Joint",
  "Index_PIP_Joint",
  "Index_DIP_Joint",
  "Middle_Roll_Joint",
  "Middle_MCP_Joint",
  "Middle_PIP_Joint",
  "Middle_DIP_Joint",
  "Ring_Roll_Joint",
  "Ring_MCP_Joint",
  "Ring_PIP_Joint",
  "Ring_DIP_Joint",
  "Little_Roll_Joint",
  "Little_MCP_Joint",
  "Little_PIP_Joint",
  "Little_DIP_Joint",
] as const;

export const ALLEX_COMPACT_HAND_JOINT_GROUPS = [
  ["Thumb_Yaw_Joint"],
  ["Thumb_CMC_Joint"],
  ["Thumb_MCP_Joint", "Thumb_IP_Joint"],
  ["Index_Roll_Joint"],
  ["Index_MCP_Joint"],
  ["Index_PIP_Joint", "Index_DIP_Joint"],
  ["Middle_Roll_Joint"],
  ["Middle_MCP_Joint"],
  ["Middle_PIP_Joint", "Middle_DIP_Joint"],
  ["Ring_Roll_Joint"],
  ["Ring_MCP_Joint"],
  ["Ring_PIP_Joint", "Ring_DIP_Joint"],
  ["Little_Roll_Joint"],
  ["Little_MCP_Joint"],
  ["Little_PIP_Joint", "Little_DIP_Joint"],
] as const;

function dipFromThumbMcp(value: number): number {
  return -0.0015 + 0.6651 * value + 0.0186 * value ** 2 + 0.1224 * value ** 3 - 0.0696 * value ** 4;
}

function dipFromFingerPip(value: number): number {
  return -0.003849 + 0.4269 * value + 0.06589 * value ** 2 + 0.136 * value ** 3 - 0.04621 * value ** 4;
}

export function coupleAllexHand(q15: readonly number[]): number[] {
  const coupled = new Array(20).fill(0);
  coupled[0] = q15[0] ?? 0;
  coupled[1] = q15[1] ?? 0;
  coupled[2] = q15[2] ?? 0;
  coupled[3] = dipFromThumbMcp(coupled[2]);
  coupled[4] = q15[3] ?? 0;
  coupled[5] = q15[4] ?? 0;
  coupled[6] = q15[5] ?? 0;
  coupled[7] = dipFromFingerPip(coupled[6]);
  coupled[8] = q15[6] ?? 0;
  coupled[9] = q15[7] ?? 0;
  coupled[10] = q15[8] ?? 0;
  coupled[11] = dipFromFingerPip(coupled[10]);
  coupled[12] = q15[9] ?? 0;
  coupled[13] = q15[10] ?? 0;
  coupled[14] = q15[11] ?? 0;
  coupled[15] = dipFromFingerPip(coupled[14]);
  coupled[16] = q15[12] ?? 0;
  coupled[17] = q15[13] ?? 0;
  coupled[18] = q15[14] ?? 0;
  coupled[19] = dipFromFingerPip(coupled[18]);
  return coupled;
}

export function allex48Values(obs: readonly number[], neckOrder: NeckOrder): Record<string, number> {
  const values: Record<string, number> = {};

  ALLEX_ARM_JOINTS.forEach((jointName, index) => {
    values[jointName] = obs[index] ?? 0;
  });
  coupleAllexHand(obs.slice(14, 29)).forEach((value, index) => {
    values[`R_${ALLEX_HAND_20_SUFFIX[index]}`] = value;
  });
  coupleAllexHand(obs.slice(29, 44)).forEach((value, index) => {
    values[`L_${ALLEX_HAND_20_SUFFIX[index]}`] = value;
  });

  if (neckOrder === "urdf-pitch-yaw") {
    values.Neck_Pitch_Joint = obs[44] ?? 0;
    values.Neck_Yaw_Joint = obs[45] ?? 0;
  } else {
    values.Neck_Yaw_Joint = obs[44] ?? 0;
    values.Neck_Pitch_Joint = obs[45] ?? 0;
  }
  values.Waist_Yaw_Joint = obs[46] ?? 0;
  values.Waist_Pitch_Lower_Joint = obs[47] ?? 0;
  values.Waist_Pitch_Upper_Joint = -(obs[47] ?? 0);

  return values;
}

export function allexStateIndexToJointNames(neckOrder: NeckOrder): string[][] {
  return [
    ...ALLEX_ARM_JOINTS.map((jointName) => [jointName]),
    ...ALLEX_COMPACT_HAND_JOINT_GROUPS.map((jointNames) => jointNames.map((jointName) => `R_${jointName}`)),
    ...ALLEX_COMPACT_HAND_JOINT_GROUPS.map((jointNames) => jointNames.map((jointName) => `L_${jointName}`)),
    neckOrder === "urdf-pitch-yaw" ? ["Neck_Pitch_Joint"] : ["Neck_Yaw_Joint"],
    neckOrder === "urdf-pitch-yaw" ? ["Neck_Yaw_Joint"] : ["Neck_Pitch_Joint"],
    ["Waist_Yaw_Joint"],
    ["Waist_Pitch_Lower_Joint", "Waist_Pitch_Upper_Joint"],
  ];
}
