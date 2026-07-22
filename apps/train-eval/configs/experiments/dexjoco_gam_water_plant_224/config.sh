# Experiment: dexjoco_gam_water_plant_224
# DexJoCo water_plant single-task GAM fine-tune at 224x224.

# ----- model -----
MODEL_ID=dexjoco-gam
TRAIN_GIT_COMMIT=69afa536658198a22750b5618322edf68fdea93a
TRAIN_MODALITY_CONFIG=gam_config.yaml
TRAIN_ACTION_HORIZON=16
TRAIN_NOTE="DexJoCo water_plant single-task - GAM 224x224, state/action 23/22"

# ----- dataset -----
export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets"
TRAIN_DATASET_NAMES=(
    water_plant
)

# ----- task -----
TASKS=(
    "water_plant|water_plant|Grasp the watering can and apply water to the plant."
)

# ----- training -----
MAX_STEPS=30000
SAVE_STEPS=10000
TRAIN_NUM_GPUS=4
TRAIN_GLOBAL_BATCH_SIZE=256

# ----- eval (DexJoCo MuJoCo harness) -----
DEXJOCO_SERVER_TYPE=gam
DEXJOCO_IMAGE_SIZE=224
DEXJOCO_EMBODIMENT_TAG=dexjoco_single_arm
EVAL_NUM_GPUS=4
N_ENVS_PER_GPU=4
N_EPISODES=50
N_RUNS=3
EVAL_SETS=(rand_obj)
DEXJOCO_INFERENCE_MODE=blocking_overlap
DEXJOCO_ACTION_HORIZON=16
DEXJOCO_REPLAN_RATIO=0.5
