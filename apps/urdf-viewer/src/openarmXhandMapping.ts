import type { UrdfModel } from "./types";

export const OPENARM_XHAND1_STATE_SIZE = 40;
export const OPENARM_XHAND1_STATE_COLUMN = "observation.joint_position";

export const OPENARM_XHAND1_JOINTS = [
  "openarm_head_pitch",
  "openarm_head_yaw",
  "openarm_left_joint1",
  "openarm_left_joint2",
  "openarm_left_joint3",
  "openarm_left_joint4",
  "openarm_left_joint5",
  "openarm_left_joint6",
  "openarm_left_joint7",
  "left_hand_thumb_bend_joint",
  "left_hand_thumb_rota_joint1",
  "left_hand_thumb_rota_joint2",
  "left_hand_index_bend_joint",
  "left_hand_index_joint1",
  "left_hand_index_joint2",
  "left_hand_mid_joint1",
  "left_hand_mid_joint2",
  "left_hand_ring_joint1",
  "left_hand_ring_joint2",
  "left_hand_pinky_joint1",
  "left_hand_pinky_joint2",
  "openarm_right_joint1",
  "openarm_right_joint2",
  "openarm_right_joint3",
  "openarm_right_joint4",
  "openarm_right_joint5",
  "openarm_right_joint6",
  "openarm_right_joint7",
  "right_hand_thumb_bend_joint",
  "right_hand_thumb_rota_joint1",
  "right_hand_thumb_rota_joint2",
  "right_hand_index_bend_joint",
  "right_hand_index_joint1",
  "right_hand_index_joint2",
  "right_hand_mid_joint1",
  "right_hand_mid_joint2",
  "right_hand_ring_joint1",
  "right_hand_ring_joint2",
  "right_hand_pinky_joint1",
  "right_hand_pinky_joint2",
] as const;

export function isOpenarmXhand1Model(model: UrdfModel): boolean {
  return OPENARM_XHAND1_JOINTS.every((jointName) => model.jointsByName.has(jointName));
}

export function openarmXhand1Values(state: readonly number[]): Record<string, number> {
  const values: Record<string, number> = {};
  OPENARM_XHAND1_JOINTS.forEach((jointName, index) => {
    values[jointName] = state[index] ?? 0;
  });
  return values;
}
