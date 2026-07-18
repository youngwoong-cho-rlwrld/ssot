# Experiment: dexjoco_gam_delta_c8_bimanual_5tasks_224
# DexJoCo bimanual multitask GAM fine-tune, 224x224 — DELTA-ACTION retrain.
# Fixes the hold-collapse of dexjoco_gam_bimanual_5tasks_224 (see
# docs/gam-dexjoco-zero-success-debug-2026-07-19.md): observation-anchored
# delta-action targets (action_frame=base_delta), chunk_size 8 (paper C=8),
# delta-space normalizer key dexjoco_dual_arm_delta, velocity loss ON.

# ----- model -----
MODEL_ID=dexjoco-gam
# gam repo branch dexjoco-delta-actions (base 6b71f21 + delta-action impl).
TRAIN_GIT_COMMIT=9648f8ee3c11e4a016ea66c4453f2784459d8d61
TRAIN_MODALITY_CONFIG=gam_config.yaml
TRAIN_ACTION_HORIZON=8
TRAIN_NOTE="DexJoCo 5-task bimanual GAM delta-action retrain: base_delta targets, C=8, delta stats key, lambda_vel=1.0 - fixes hold-collapse of the absolute-target run"

# ----- datasets -----
export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets"

# Informational for GAM: the authoritative dataset list/weights/dims live in
# gam_config.yaml. GAM's train wrapper does not read these bash arrays.
TRAIN_DATASET_NAMES=(
    bimanual_assembly
    bimanual_hanoi
    bimanual_microwave_cook
    bimanual_photograph
    bimanual_unlock_ipad
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
TRAIN_NUM_GPUS=8
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
