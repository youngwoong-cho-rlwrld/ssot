# GAM released-recipe DexJoCo adaptation: water_plant single task, both views.

MODEL_ID=dexjoco-gam
TRAIN_GIT_COMMIT=6e3f68d
TRAIN_MODALITY_CONFIG=gam_config.yaml
TRAIN_ACTION_HORIZON=8
TRAIN_NOTE="GAM released recipe on DexJoCo water_plant: T9 H1 K8, both cameras, batch256, 30k, 4 GPUs"

export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets_224"
MLXP_DATA_DIR=/data/youngwoong/datasets/dexjoco_lerobot_datasets_224

TRAIN_DATASET_NAMES=(
    water_plant
)

TASKS=(
    "water_plant|water_plant|Grasp the watering can and apply water to the plant."
)

MAX_STEPS=30000
SAVE_STEPS=10000
TRAIN_NUM_GPUS=4
TRAIN_GLOBAL_BATCH_SIZE=256
TRAIN_NUM_WORKERS=8

DEXJOCO_SERVER_TYPE=gam
DEXJOCO_IMAGE_SIZE=224
DEXJOCO_EMBODIMENT_TAG=dexjoco_single_arm
EVAL_NUM_GPUS=4
N_ENVS_PER_GPU=2
N_EPISODES=50
N_RUNS=3
EVAL_SETS=(rand_obj)
DEXJOCO_NO_PROGRESS_TIMEOUT_SECONDS=900
DEXJOCO_INFERENCE_MODE=sync
DEXJOCO_ACTION_HORIZON=8
# The client replans when remaining < ratio*8. At 0.125 it requests only
# after the eighth action has been consumed: exactly eight open-loop actions.
DEXJOCO_REPLAN_RATIO=0.125
