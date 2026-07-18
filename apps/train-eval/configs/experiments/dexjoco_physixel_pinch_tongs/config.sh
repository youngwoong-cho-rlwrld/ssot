# Experiment: dexjoco_physixel_pinch_tongs
# DexJoCo pinch_tongs - physixel (single-arm). Train + eval; pick the phase at submit.

# ───── model ─────
MODEL_ID=dexjoco-physixel
TRAIN_GIT_COMMIT=73f2aeb02220e430445af9e18051cadf6f2a9a9f
TRAIN_MODALITY_CONFIG=dexjoco_config.py            # n1.6 modality config (path relative to this dir)
TRAIN_ACTION_HORIZON=16
TRAIN_NOTE="DexJoCo pinch_tongs - physixel 256x256 (single-arm) [physixel @73f2aeb]"

# ───── datasets ─────
export DATA_DIR="$HOME/workspace/dexjoco_n16/src_v30/dexjoco_lerobot_datasets"
DATASET_NAME=pinch_tongs

# ───── task (eval-time policy prompt) ─────
TASKS=(
    "__single__|pinch_tongs|Grasp the tongs and perform three consecutive open-close motions."
)

# ───── training ─────
MAX_STEPS=10000
SAVE_STEPS=10000                      # save only at the end
TRAIN_NUM_GPUS=4
TRAIN_GLOBAL_BATCH_SIZE=128
TRAIN_EXTRA_ARGS=()

# ───── eval (DexJoCo MuJoCo harness) ─────
DEXJOCO_SERVER_TYPE=groot
DEXJOCO_IMAGE_SIZE=256
EVAL_NUM_GPUS=4
N_EPISODES=50
N_RUNS=1
EVAL_SETS=(rand_obj)
# eval: supply EVAL_CHECKPOINT = the finetune output dir for pinch_tongs
DEXJOCO_INFERENCE_MODE=blocking_overlap
DEXJOCO_ACTION_HORIZON=16
DEXJOCO_REPLAN_RATIO=0.5
