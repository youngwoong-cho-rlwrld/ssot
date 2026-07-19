# Experiment: heuristic_pt9_hands_3way
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

# State index groups:
# 1 body
# 2 left arm
# 3 right arm
# 4 left thumb
# 5 left index
# 6 left middle + ring + little
# 7 right thumb
# 8 right index
# 9 right middle + ring + little
TRAIN_EXTRA_ARGS=(
    --state-part-mode
    explicit
    --state-part-token-count
    9
    --state-part-groups-json
    '[[45,44,46,47],[7,8,9,10,11,12,13],[0,1,2,3,4,5,6],[29,30,31],[32,33,34],[35,36,37,38,39,40,41,42,43],[14,15,16],[17,18,19],[20,21,22,23,24,25,26,27,28]]'
)
TRAIN_NOTE="PoC2 heuristic state tokens K=9: body, arms, each hand split into thumb/index/rest; PhysiXel 9f731f9, AH16"
