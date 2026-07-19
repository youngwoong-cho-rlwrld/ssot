# Experiment: physixel_poc5_perpart_ps0
# PhysiXel PoC5 action encoder mode=per_part on action part tokens (G=3) + state tokens K=15, bs128, on 3 V4 sim datasets at 480x640, AH16.

MODEL_ID=physixel
TRAIN_GIT_COMMIT=97597a50c0c91ad6ab3384979e36e348fea81cd3

TRAIN_MODALITY_CONFIG=allex_egostereo_ck16_config_absolute.py
TRAIN_ACTION_HORIZON=16

export DATA_DIR="$HOME/datasets"

TRAIN_DATASET_NAMES=(
    v4_cube_box_5cm_left_480
    v4_cube_stack_3cm_right_480
    v4_cylinder_tube_place_7cm_left_480
)
DATA_CONFIG=allex_thetwo_ck40_egostereo

TASKS=(
    "cube_box_5cm_left|task-Cube_Box-5cmLeft|Pick up the cube with your left hand and place it in the box"
    "cube_stack_3cm_right|task-Cube_Stack-3cmRight|Pick the red cube with your right hand and stack it on the blue cube."
    "cylinder_tube_place_7cm_left|task-Cylinder_Tube_Place-T15cmC7cmLeft|Lift the cylinder with your left hand and place it in the middle of the tube without touching the tube."
)

MAX_STEPS=30000
SAVE_STEPS=30000

N_EPISODES=70
EXECUTION_HORIZON=8
MAX_EPISODE_STEPS=300
N_RUNS=3
EVAL_NUM_ENVS_PER_GPU=1
EVAL_PIN_CUDA_DEVICES=1
EVAL_UNSET_CUDA_VISIBLE_DEVICES_FOR_SERVER=0
EVAL_PIN_CLIENT_CUDA_DEVICES=1
EVAL_SETS=(0cm 1cm 3cm 5cm 7cm)

TRAIN_NUM_GPUS=2
TRAIN_GLOBAL_BATCH_SIZE=128
TRAIN_EXTRA_ARGS=(
    --state-part-mode
    random_balanced
    --state-part-token-count
    15
    --state-part-seed
    0
    --action-part-mode
    random_balanced
    --action-part-token-count
    3
    --action-part-seed
    0
    --action-encoder-mode
    per_part
)
TRAIN_NOTE="PoC5 action encoder mode=per_part + action part tokens G=3 seed=0 + state tokens K=15 seed=0; bs128 (2x64); control=PoC3 ag3; PhysiXel feature/physixel-poc5-action-encoder-modes 97597a5, AH16"
