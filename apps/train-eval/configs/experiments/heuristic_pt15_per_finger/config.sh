# Experiment: heuristic_pt15_per_finger
# PhysiXel PoC2 heuristic state tokens on 3 V4 sim datasets at 480x640, AH16.

MODEL_ID=physixel
TRAIN_GIT_COMMIT=9f731f9f38adef6c925d8c0751216d6866c7398d

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

# State index groups (heuristic, K=15; within 1.9545, between 1.4064, ratio 1.390, kept 6.5%):
# K=13 fully decomposes each hand to per-finger, so K=15 additionally splits each arm into upper (shoulder+elbow) and wrist.
# 1 body (neck + waist)
# 2 right arm upper (shoulder + elbow)
# 3 right wrist
# 4 left arm upper (shoulder + elbow)
# 5 left wrist
# 6 right thumb
# 7 right index
# 8 right middle
# 9 right ring
# 10 right little
# 11 left thumb
# 12 left index
# 13 left middle
# 14 left ring
# 15 left little
TRAIN_EXTRA_ARGS=(
    --state-part-mode
    explicit
    --state-part-token-count
    15
    --state-part-groups-json
    '[[44,45,46,47],[0,1,2,3],[4,5,6],[7,8,9,10],[11,12,13],[14,15,16],[17,18,19],[20,21,22],[23,24,25],[26,27,28],[29,30,31],[32,33,34],[35,36,37],[38,39,40],[41,42,43]]'
)
TRAIN_NOTE="PoC2 heuristic state tokens K=15: body, each arm split upper/wrist, both hands per-finger; PhysiXel 9f731f9, AH16"
