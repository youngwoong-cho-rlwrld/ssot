# Experiment: discrete_MI_pt15_random_33
# PhysiXel PoC2 explicit MI state tokens on 3 V4 sim datasets at 480x640, AH16.

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

# State index groups (discrete MI optimized, K=15, source random-33; within 2.3512, between 1.3864, ratio 1.696, kept 7.9%):
# 1: L_Thumb_Yaw, L_Thumb_MCP+Thumb_IP, L_Index_MCP, L_Middle_MCP
# 2: L_Index_Roll, L_Middle_Roll, L_Ring_Roll, L_Little_Roll
# 3: L_Ring_MCP, L_Ring_PIP+Ring_DIP, L_Little_MCP, L_Little_PIP+Little_DIP
# 4: R_Shoulder_Pitch, R_Elbow, R_Wrist_Roll
# 5: R_Shoulder_Roll, R_Wrist_Yaw, R_Wrist_Pitch
# 6: R_Shoulder_Yaw, Neck_Yaw, Waist_Pitch_Lower+Waist_Pitch_Upper
# 7: L_Shoulder_Pitch, L_Elbow, L_Wrist_Roll
# 8: L_Shoulder_Roll, L_Wrist_Yaw, L_Wrist_Pitch
# 9: L_Shoulder_Yaw, Neck_Pitch, Waist_Yaw
# 10: R_Thumb_Yaw, R_Index_Roll, R_Little_PIP+Little_DIP
# 11: R_Thumb_CMC, R_Thumb_MCP+Thumb_IP, R_Index_MCP
# 12: R_Index_PIP+Index_DIP, R_Middle_PIP+Middle_DIP, R_Ring_PIP+Ring_DIP
# 13: R_Middle_Roll, R_Ring_Roll, R_Little_Roll
# 14: R_Middle_MCP, R_Ring_MCP, R_Little_MCP
# 15: L_Thumb_CMC, L_Index_PIP+Index_DIP, L_Middle_PIP+Middle_DIP
TRAIN_EXTRA_ARGS=(
    --state-part-mode
    explicit
    --state-part-token-count
    15
    --state-part-groups-json
    '[[29,31,33,36],[32,35,38,41],[39,40,42,43],[0,3,5],[1,4,6],[2,44,47],[7,10,12],[8,11,13],[9,45,46],[14,17,28],[15,16,18],[19,22,25],[20,23,26],[21,24,27],[30,34,37]]'
)
TRAIN_NOTE="PoC2 explicit MI state tokens K=15 random-33 (ratio 1.696); PhysiXel 9f731f9, AH16"
