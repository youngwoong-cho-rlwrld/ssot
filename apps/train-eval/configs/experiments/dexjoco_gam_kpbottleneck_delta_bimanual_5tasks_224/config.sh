# Experiment: dexjoco_gam_kpbottleneck_delta_bimanual_5tasks_224
# DexJoCo bimanual multitask GAM fine-tune at 224x224 — REVISED keypoint action
# bottleneck that fixes the hold-collapse on BOTH paths at once:
#   * ACTION path -> DELTA (base_delta observation-anchored deltas, delta stats
#     key dexjoco_dual_arm_delta, velocity loss ON), inherited from the plain
#     delta variant. The keypoint head's decoder is supervised against the delta
#     targets (decoder-anchor decode(GT_kp)->GT_delta AND decoded-action
#     decode(pred_kp)->GT_delta), so neither admits the absolute "hold" optimum.
#   * KEYPOINT path -> RELATIVE: the 126-D keypoint targets are observation-
#     anchored relative motions rel_k = kp_{t+k} - kp_t (anchor = chunk first
#     frame), normalized by a keypoint-delta normalizer on that relative
#     distribution. Absolute camera-frame keypoints were 99.7% DC (within/total
#     variance ~0.33%); relative are ~30.8% (measured on the 5 kp datasets).
# Head still OUTPUTS a 44-D delta chunk under a *_delta stats key, so the eval
# server reconstructs absolute (a_abs = delta + p44(state)) with ZERO changes.
# Datasets are the keypoint-augmented copies (*_kp) of the 5 bimanual tasks.

# ----- model -----
MODEL_ID=dexjoco-gam
# gam repo branch dexjoco-kpbottleneck-delta (off dexjoco-delta-actions 5b340e3):
#   4a0f23b port keypoint-bottleneck head + KeypointNormalizer onto the delta branch
#   3ed78a1 observation-anchored RELATIVE keypoint targets + delta-kp normalizer
TRAIN_GIT_COMMIT=3ed78a1c51700c66ae444578639d9c8e8019d13d
# GAM training config (second file, owned by the GAM-port workstream). Lists
# datasets/weights/dims and the action chunk size; consumed via GAM_CONFIG_YAML.
TRAIN_MODALITY_CONFIG=gam_config.yaml
TRAIN_ACTION_HORIZON=8
TRAIN_NOTE="DexJoCo 5-task bimanual GAM keypoint-bottleneck DELTA revision: relative keypoint targets (kp_dim 126, camera-front) + base_delta actions, C=8, delta stats key dexjoco_dual_arm_delta, velocity loss ON, kp-augmented datasets - fixes both-path hold-collapse of the absolute kpbottleneck v1"

# ----- datasets -----
# Keypoints are required, so keep the keypoint-augmented (*_kp) copies. On MLXP
# these resolve by NAME from the cluster datasets_dir (/data/youngwoong/datasets/
# <name>); all 5 *_kp names exist there.
export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets_kp"

# Informational for GAM: the authoritative dataset list/weights/dims live in
# gam_config.yaml. GAM's train wrapper does not read these bash arrays.
TRAIN_DATASET_NAMES=(
    bimanual_assembly_kp
    bimanual_hanoi_kp
    bimanual_microwave_cook_kp
    bimanual_photograph_kp
    bimanual_unlock_ipad_kp
)

# ----- tasks -----
TASKS=(
    "bimanual_assembly|bimanual_assembly|Grasp the tray with the left hand and the peg with the right hand, then insert the peg into the hole."
    "bimanual_hanoi|bimanual_hanoi|Execute the final two moves of the three-level Tower of Hanoi: move the medium disk from the middle peg to the right peg with the right hand, then move the small disk from the left peg to the right peg with the left hand."
    "bimanual_microwave_cook|bimanual_microwave_cook|Open the microwave door, place the food inside the microwave, close the door, and press the start button."
    "bimanual_photograph|bimanual_photograph|Grasp the camera with the left hand, align it with the logo, and press the shutter button with the right hand."
    "bimanual_unlock_ipad|bimanual_unlock_ipad|Grasp the iPad and enter the password 123 to unlock the device."
)

# ----- training -----
MAX_STEPS=30000
SAVE_STEPS=10000
TRAIN_NUM_GPUS=4
TRAIN_GLOBAL_BATCH_SIZE=512

# ----- eval (DexJoCo MuJoCo harness) -----
DEXJOCO_SERVER_TYPE=gam
DEXJOCO_IMAGE_SIZE=224
DEXJOCO_EMBODIMENT_TAG=dexjoco_dual_arm
DEXJOCO_EMBODIMENT_TAG_BIMANUAL=dexjoco_dual_arm
EVAL_NUM_GPUS=4
# Concurrent sim workers per GPU (~12G VRAM each): 4 sized for H200
# (rlwrld-gpu); drop to 2 for L40S 48G partitions.
N_ENVS_PER_GPU=4
N_EPISODES=50
N_RUNS=3
EVAL_SETS=(rand_obj)
# SKT clients die silently in node-correlated windows; 900s no-progress
# detection (vs 2400s default) turns each death into a ~15min retry
# instead of ~40min. Server load+warmup is ~6min, so ample margin.
DEXJOCO_NO_PROGRESS_TIMEOUT_SECONDS=900
DEXJOCO_INFERENCE_MODE=blocking_overlap
DEXJOCO_ACTION_HORIZON=8
DEXJOCO_REPLAN_RATIO=0.5
