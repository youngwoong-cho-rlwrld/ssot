# Variant: n16_baseline_scratch
# GR00T N1.6 + random-init action head (--random-diffusion), no --tune-visual

MODEL_ID=n1.6

# Modality config: a per-variant Python file (path is RELATIVE to experiments/<variant>/)
TRAIN_MODALITY_CONFIG=allex_egostereo_ck40_config_absolute.py

# Shared eval scenario config (currently identical across all variants).
# Override here if a variant ever needs a different task/dataset/instruction.
DATASET_NAME=v4_cube_box_5cm_left_100_100
DATA_CONFIG=allex_thetwo_ck40_egostereo

TASKS=(
    "__single__|task-Cube_Box-5cmLeft|Pick up the cube with your left hand and place it in the box"
)

# Training
MAX_STEPS=30000
SAVE_STEPS=30000  # save only at the end

# Evaluation (eval support for n1.6 is TBD — train only for now)
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
TRAIN_EXTRA_ARGS=(--random-diffusion)
TRAIN_NOTE="GR00T N1.6 baseline_scratch (--random-diffusion)"
