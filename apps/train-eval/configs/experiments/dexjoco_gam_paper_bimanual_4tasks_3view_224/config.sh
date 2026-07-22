# GAM released-recipe DexJoCo adaptation: four bimanual tasks, all three views.

MODEL_ID=dexjoco-gam
TRAIN_GIT_COMMIT=6e3f68d
TRAIN_MODALITY_CONFIG=gam_config.yaml
TRAIN_ACTION_HORIZON=8
TRAIN_NOTE="GAM released recipe on four DexJoCo bimanual tasks: T9 H1 K8, all three cameras, batch256, 30k"

export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets_224"
MLXP_DATA_DIR=/data/youngwoong/datasets/dexjoco_lerobot_datasets_224

TRAIN_DATASET_NAMES=(
    bimanual_assembly
    bimanual_hanoi
    bimanual_microwave_cook
    bimanual_photograph
)

TASKS=(
    "bimanual_assembly|bimanual_assembly|Grasp the tray with the left hand and the peg with the right hand, then insert the peg into the hole."
    "bimanual_hanoi|bimanual_hanoi|Execute the final two moves of the three-level Tower of Hanoi: move the medium disk from the middle peg to the right peg with the right hand, then move the small disk from the left peg to the right peg with the left hand."
    "bimanual_microwave_cook|bimanual_microwave_cook|Open the microwave door, place the food inside the microwave, close the door, and press the start button."
    "bimanual_photograph|bimanual_photograph|Grasp the camera with the left hand, align it with the logo, and press the shutter button with the right hand."
)

MAX_STEPS=30000
SAVE_STEPS=10000
TRAIN_NUM_GPUS=8
TRAIN_GLOBAL_BATCH_SIZE=256
TRAIN_NUM_WORKERS=8

DEXJOCO_SERVER_TYPE=gam
DEXJOCO_IMAGE_SIZE=224
DEXJOCO_EMBODIMENT_TAG=dexjoco_dual_arm
DEXJOCO_EMBODIMENT_TAG_BIMANUAL=dexjoco_dual_arm
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
