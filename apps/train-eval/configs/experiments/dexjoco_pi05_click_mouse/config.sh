# Experiment: dexjoco_pi05_click_mouse
# DexJoCo click_mouse - pi0.5 baseline (openpi serve_policy + MuJoCo client). Eval-only.

# ───── model ─────
MODEL_ID=dexjoco-pi05
TRAIN_NOTE="DexJoCo click_mouse - pi0.5 baseline"

# ───── task (eval-time policy prompt) ─────
TASKS=(
    "__single__|click_mouse|Move the mouse to the purple mouse pad and click the left mouse button."
)

# ───── eval (DexJoCo MuJoCo harness) ─────
DEXJOCO_SERVER_TYPE=openpi
N_EPISODES=50
N_RUNS=1
EVAL_SETS=(rand_obj)
# Eval-only: submit phase=eval; EVAL_CHECKPOINT=~/workspace/dexjoco/checkpoints/pi05_dexjoco_ckpt/click_mouse
DEXJOCO_INFERENCE_MODE=blocking_overlap
DEXJOCO_ACTION_HORIZON=30
DEXJOCO_REPLAN_RATIO=0.8
