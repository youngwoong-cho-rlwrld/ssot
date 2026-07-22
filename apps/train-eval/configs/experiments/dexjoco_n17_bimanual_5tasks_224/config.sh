# Experiment: dexjoco_n17_bimanual_5tasks_224
# DexJoCo five-task bimanual multitask GR00T N1.7 fine-tune at 224x224.

# ----- model -----
MODEL_ID=dexjoco-n17
TRAIN_DATA_YAML=data_config.yaml
TRAIN_MODALITY_CONFIG=dexjoco_config_front.py
TRAIN_ACTION_HORIZON=16
TRAIN_NOTE="DexJoCo 5-task bimanual multitask - GR00T N1.7 224x224, state/action 46/44"

# ----- datasets -----
export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets"

# The N1.7 multi-dataset launcher consumes data_config.yaml. Keep this list in
# parallel so train-eval-web can resolve and display the selected datasets.
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
MAX_STEPS=10000
SAVE_STEPS=10000
TRAIN_NUM_GPUS=4
TRAIN_GLOBAL_BATCH_SIZE=128
TRAIN_EXTRA_ARGS=(--shortest-image-edge 224 --crop-fraction 1.0)

# ----- eval (DexJoCo MuJoCo harness) -----
DEXJOCO_SERVER_TYPE=groot
DEXJOCO_IMAGE_SIZE=224
DEXJOCO_EMBODIMENT_TAG=new_embodiment
DEXJOCO_EMBODIMENT_TAG_BIMANUAL=new_embodiment
EVAL_NUM_GPUS=4
N_EPISODES=50
N_RUNS=3
EVAL_SETS=(rand_obj)
DEXJOCO_INFERENCE_MODE=blocking_overlap
DEXJOCO_ACTION_HORIZON=16
DEXJOCO_REPLAN_RATIO=0.5
