# Variant: n15_cube_box_5cm_left_480
# GR00T N1.5 fine-tune on V4 sim cube_box at 480x640.

MODEL_ID=n1.5

export DATA_DIR="$HOME/datasets"
DATASET_NAME=v4_cube_box_5cm_left_480
DATA_CONFIG=allex_thetwo_ck40_egostereo

TASKS=(
    "__single__|task-Cube_Box-5cmLeft|Pick up the cube with your left hand and place it in the box"
)

# Training
MAX_STEPS=30000
SAVE_STEPS=1000

# Evaluation
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
TRAIN_BATCH_SIZE=64
TRAIN_EXTRA_ARGS=()
TRAIN_NOTE="N1.5 pretrained @ 480x640, no --random-diffusion, no --tune-visual"
