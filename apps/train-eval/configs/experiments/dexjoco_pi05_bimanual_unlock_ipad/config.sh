# Experiment: dexjoco_pi05_bimanual_unlock_ipad
# DexJoCo bimanual_unlock_ipad - pi0.5 baseline (openpi serve_policy + MuJoCo client). Eval-only.

# ───── model ─────
MODEL_ID=dexjoco-pi05
TRAIN_NOTE="DexJoCo bimanual_unlock_ipad - pi0.5 baseline"

# ───── task (eval-time policy prompt) ─────
TASKS=(
    "__single__|bimanual_unlock_ipad|Grasp the iPad and enter the password 123 to unlock the device."
)

# ───── eval (DexJoCo MuJoCo harness) ─────
DEXJOCO_SERVER_TYPE=openpi
N_EPISODES=50
N_RUNS=1
EVAL_SETS=(rand_obj)
# Eval-only: submit phase=eval; EVAL_CHECKPOINT=~/workspace/dexjoco/checkpoints/pi05_dexjoco_ckpt/bimanual_unlock_ipad
DEXJOCO_INFERENCE_MODE=blocking_overlap
DEXJOCO_ACTION_HORIZON=30
DEXJOCO_REPLAN_RATIO=0.8
