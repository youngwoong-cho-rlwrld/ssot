# Experiment: discrete_MI_pt3_random_1
# PhysiXel PoC1-style explicit MI state tokens on 3 V4 sim datasets at 480x640, AH16.

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
# 1: R_Shoulder_Pitch, R_Shoulder_Roll, R_Shoulder_Yaw, R_Elbow, R_Wrist_Yaw, R_Wrist_Roll, R_Wrist_Pitch, L_Shoulder_Pitch, L_Shoulder_Roll, L_Shoulder_Yaw, L_Wrist_Yaw, L_Wrist_Roll, Neck_Pitch, Neck_Yaw, Waist_Yaw, Waist_Pitch_Lower+Waist_Pitch_Upper
# 2: L_Elbow, L_Wrist_Pitch, L_Thumb_Yaw, L_Thumb_CMC, L_Thumb_MCP+Thumb_IP, L_Index_Roll, L_Index_MCP, L_Middle_Roll, L_Middle_MCP, L_Middle_PIP+Middle_DIP, L_Ring_Roll, L_Ring_MCP, L_Ring_PIP+Ring_DIP, L_Little_Roll, L_Little_MCP, L_Little_PIP+Little_DIP
# 3: R_Thumb_Yaw, R_Thumb_CMC, R_Thumb_MCP+Thumb_IP, R_Index_Roll, R_Index_MCP, R_Index_PIP+Index_DIP, R_Middle_Roll, R_Middle_MCP, R_Middle_PIP+Middle_DIP, R_Ring_Roll, R_Ring_MCP, R_Ring_PIP+Ring_DIP, R_Little_Roll, R_Little_MCP, R_Little_PIP+Little_DIP, L_Index_PIP+Index_DIP
TRAIN_EXTRA_ARGS=(
    --state-part-mode
    explicit
    --state-part-token-count
    3
    --state-part-groups-json
    '[[0,1,2,3,4,5,6,7,8,9,11,12,45,44,46,47],[10,13,29,30,31,32,33,35,36,37,38,39,40,41,42,43],[14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,34]]'
)
TRAIN_NOTE="PoC1-style explicit MI state tokens K=3 random-1; PhysiXel feature/physixel-poc1-part-state-tokens 9f731f9, AH16"
