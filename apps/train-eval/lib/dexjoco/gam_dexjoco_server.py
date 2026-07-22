"""Websocket policy server exposing a fine-tuned GAM (Geometric Action Model)
DexJoCo policy over the openpi-client protocol the DexJoCo eval client speaks.

Byte-compatible with lib/dexjoco/gr00t_dexjoco_server.py:
  obs in  (single-arm): {"base", "wrist": uint8[H,W,3], "state": float[23], "prompt": str}
  obs in  (dual-arm):   {"base", "wrist_left", "wrist_right": uint8[H,W,3], "state": float[46], "prompt": str}
  obs out : {"actions": float32[horizon, D]}  D=22 single-arm, 44 dual-arm

Camera inputs follow ``dataset.rollout_camera_keys`` from the checkpoint config.
DexJoCo's ``base`` image maps to GAM's ``front`` key; ``wrist_left`` and
``wrist_right`` are forwarded unchanged. State and actions are raw joint-space
vectors (no EEF math).

Multi-embodiment mapping (a 44-D multitask model served for a single-arm task,
--embodiment-tag dexjoco_single_arm):
  * incoming state is zero-padded 23 -> model proprio_dim (46), native dims in [0:23];
  * outgoing actions are sliced 44 -> 22 (the [0:22] right-arm block).
This mirrors the dataset's single_to_dual padding (see dexjoco/DEXJOCO_INTEGRATION.md).

The model is built with the GAM repo's ``load_stage1_policy`` (run with
PYTHONPATH=$GAM_DIR/src). One model step (== chunk_size env actions) is
returned per request, matching the GR00T server's per-call action chunk.
For checkpoints trained with observation history, the server keeps the rollout
closure's episode state across requests. For the released H=1 recipe it never
commits a previous observation, so every request is a single-step input.

The websocket/msgpack/healthz/worker-thread protocol is copied verbatim from the
GR00T server so the harness client and eval_body_dexjoco.sh need no changes.
"""
import argparse
import asyncio
import http
import logging
import os
import traceback

import numpy as np
import torch
import websockets
import websockets.asyncio.server as _server
import websockets.frames
from omegaconf import OmegaConf

import msgpack_numpy  # copied next to this file from openpi_client

from eval_libero_unified import load_stage1_policy  # GAM repo src on PYTHONPATH

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gam_dexjoco_server")

DEFAULT_PROMPT = "Grasp the watering can and apply water to the plant."

# Output action dim the DexJoCo client expects per embodiment tag.
_TAG_ACTION_DIM = {
    "dexjoco_single_arm": 22,
    "dexjoco_dual_arm": 44,
}


def _resolve_checkpoint(checkpoint_path: str) -> tuple[str, str]:
    """Return (ckpt_file, config_yaml) from a submission dir or a direct .pt.

    A submission passes its checkpoint dir; the training wrapper writes
    ``checkpoint-final.pt`` + ``config.yaml`` there (see dexjoco/train_dexjoco.sh).
    A direct ``.pt`` path is also accepted (config.yaml is read from its parent).
    """
    if os.path.isdir(checkpoint_path):
        ckpt_file = os.path.join(checkpoint_path, "checkpoint-final.pt")
        config_dir = checkpoint_path
    else:
        ckpt_file = checkpoint_path
        config_dir = os.path.dirname(checkpoint_path)
    if not os.path.exists(ckpt_file):
        raise FileNotFoundError(f"GAM checkpoint not found: {ckpt_file}")
    config_yaml = os.path.join(config_dir, "config.yaml")
    if not os.path.exists(config_yaml):
        raise FileNotFoundError(f"GAM config.yaml not found next to checkpoint: {config_yaml}")
    return ckpt_file, config_yaml


class GamDexJoCoPolicy:
    def __init__(self, checkpoint_path: str, embodiment_tag: str, default_prompt: str):
        if embodiment_tag not in _TAG_ACTION_DIM:
            raise ValueError(
                f"Unknown --embodiment-tag {embodiment_tag!r}; expected one of {sorted(_TAG_ACTION_DIM)}."
            )
        self.default_prompt = default_prompt
        self.d_out = _TAG_ACTION_DIM[embodiment_tag]
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        ckpt_file, config_yaml = _resolve_checkpoint(checkpoint_path)
        cfg = OmegaConf.load(config_yaml)
        ckpt = torch.load(ckpt_file, map_location="cpu", weights_only=False)

        self.model_n_dims = int(cfg.action_head.n_dims)
        self.proprio_dim = int(cfg.proprioception.proprio_dim)
        if self.d_out > self.model_n_dims:
            raise ValueError(
                f"embodiment-tag wants {self.d_out}-D actions but the model outputs "
                f"{self.model_n_dims}-D (checkpoint/config mismatch)."
            )

        # EMA weights when the checkpoint carries them (train_dexjoco.sh runs
        # with training.ema.enabled); plain weights otherwise instead of the
        # hard failure _require_stage1_ema_state would raise.
        use_ema = any(
            ckpt.get(key) is not None
            for key in (
                "student_da3_ema",
                "action_head_ema",
                "future_predictor_ema",
                "text_conditioner_proj_ema",
            )
        )
        # raw_task_text: DexJoCo trains on the LeRobot tasks.jsonl strings as-is
        # (no LIBERO lowercase/punctuation normalization).
        # rollout_decode_horizon=1: with active_action_horizon=1 the AR decode
        # is exactly the one executed model step; the default "full" would
        # decode the whole native train horizon per request only to discard it.
        self.policy, self.info = load_stage1_policy(
            cfg,
            ckpt,
            ckpt_file,
            device,
            stats_key=None,
            action_stats_json=None,
            decode_visuals=False,
            rollout_decode_horizon=1,
            text_prompt_normalization="raw_task_text",
            use_ema=use_ema,
        )
        # One model step per call == chunk_size env actions == the GR00T-style
        # action chunk; the harness executes the whole chunk open-loop.
        # active_action_horizon=1 + rollout_decode_horizon=1 (above) stay: they
        # control only the AR decode/execute length (eval_libero_unified.py
        # :3139-3149), which is exactly one model step per request here. The
        # history window is governed separately by stage1_history_horizon.
        self.policy.active_action_horizon = 1

        rollout_camera_keys = self.info.get("rollout_camera_keys") or ["front"]
        self.rollout_camera_keys = tuple(str(key) for key in rollout_camera_keys)
        supported_camera_keys = {"front", "wrist", "wrist_left", "wrist_right"}
        unsupported = set(self.rollout_camera_keys) - supported_camera_keys
        if unsupported:
            raise ValueError(
                "Unsupported GAM rollout camera keys "
                f"{sorted(unsupported)}; supported={sorted(supported_camera_keys)}."
            )
        history_choices = self.info.get("stage1_H_choices") or cfg.predictor.get(
            "H_choices", [1]
        )
        self._use_history = max(int(value) for value in history_choices) > 1

        # --- Episode state across requests ---
        # The closure accumulates history only via its commit protocol: a bare
        # policy() call stages pending_history but never commits it, so every
        # call would see prev_count=0 / H_eff=1 (eval_libero_unified.py:2995,
        # :3018, :3454). We commit one anchor per request and reset only at
        # episode boundaries, restoring the trained multi-step regime.
        self._last_state: np.ndarray | None = None      # boundary detection
        self._prev_returned_chunk: np.ndarray | None = None  # executed-action feedback
        # Measured on bimanual_microwave_cook probes (job 162856, 2026-07-19):
        # in-episode consecutive-request deltas reach ~2.5 during early-episode
        # fast motion (typical 0.02-0.9), while a true env reset jumps 5.6-6.3.
        # 3.5 sits between the observed in-episode max and boundary min with
        # ~1.6x margin each way. A missed boundary contaminates at most the
        # history horizon (7 commits); a spurious reset degrades one step to
        # the old memoryless behavior.
        self._reset_state_l2_threshold = float(
            os.environ.get("GAM_SERVER_RESET_STATE_L2", "3.5")
        )
        self.policy.reset_episode()
        # Delta-action checkpoints (branch dexjoco-delta-actions, stats key
        # *_delta): the model outputs observation-anchored deltas
        # delta_k = a_{t+k}^abs - p(t). Reconstruct absolute targets by adding
        # the proprio projection of the request's own state: p44 (dual, 46->44)
        # or p22 (single, 23->22), quat wxyz -> rotvec per arm. Past-action
        # feedback stays in DELTA space, the action space training saw.
        stats_key = str(self.info.get("action_stats_key") or "")
        self._delta_mode = stats_key.endswith("_delta")
        self._proprio_to_p = None
        if self._delta_mode:
            # Single-arm (proprio_dim 23 -> p22) vs bimanual (proprio_dim 46 ->
            # p44); the p map is layout specific, keyed off the model's own
            # proprio_dim. Imported lazily so non-delta serving never pulls robot.*.
            if self.proprio_dim == 23:
                from robot.data.dexjoco_lerobot import dexjoco_single_proprio_to_p22
                self._proprio_to_p = dexjoco_single_proprio_to_p22
            else:
                from robot.data.dexjoco_lerobot import dexjoco_dual_proprio_to_p44
                self._proprio_to_p = dexjoco_dual_proprio_to_p44
        logger.info(
            "GAM policy loaded from %s (model_n_dims=%d proprio_dim=%d d_out=%d chunk_size=%s stats_key=%s delta_mode=%s cameras=%s history=%s)",
            ckpt_file, self.model_n_dims, self.proprio_dim, self.d_out,
            self.info.get("chunk_size"), self.info.get("action_stats_key"),
            self._delta_mode, self.rollout_camera_keys, self._use_history,
        )

    def _prep_state(self, state) -> np.ndarray:
        state = np.asarray(state, dtype=np.float32).reshape(-1)
        if state.shape[0] > self.proprio_dim:
            raise ValueError(
                f"Incoming state dim {state.shape[0]} exceeds model proprio_dim {self.proprio_dim}."
            )
        if state.shape[0] < self.proprio_dim:  # single-arm obs into a dual model
            padded = np.zeros(self.proprio_dim, dtype=np.float32)
            padded[: state.shape[0]] = state
            state = padded
        return state

    def infer(self, obs: dict) -> dict:
        prompt = obs.get("prompt", self.default_prompt)
        if isinstance(prompt, bytes):
            prompt = prompt.decode()

        client_camera_keys = {
            "front": "base",
            "wrist": "wrist",
            "wrist_left": "wrist_left",
            "wrist_right": "wrist_right",
        }
        closure_obs = {"state": self._prep_state(obs["state"])}
        for model_key in self.rollout_camera_keys:
            client_key = client_camera_keys[model_key]
            if client_key not in obs:
                raise KeyError(
                    f"Checkpoint expects camera {model_key!r}, but request has "
                    f"only {sorted(key for key in obs if key != 'state')}."
                )
            closure_obs[model_key] = np.asarray(obs[client_key], dtype=np.uint8)

        # Episode boundary detection. The DexJoCo client keeps ONE websocket
        # for all episodes and sends no episode index or reset flag
        # (eval_dexjoco_openpi.py:594-607; get_obs() -> base/wrist/state/prompt
        # only), and the prompt is constant across episodes of a task — the
        # only usable boundary signal is the proprio jump to the home pose.
        cur_state = closure_obs["state"]
        delta = (
            float(np.linalg.norm(cur_state - self._last_state))
            if self._last_state is not None
            else float("inf")
        )
        self._req_count = getattr(self, "_req_count", 0) + 1
        if delta > self._reset_state_l2_threshold:
            self.policy.reset_episode()  # also clears the KV/shallow caches
            self._prev_returned_chunk = None
            self._commit_count = 0
            logger.info(
                "episode boundary: req=%d state_l2=%.3f (threshold %.3f)",
                self._req_count, delta, self._reset_state_l2_threshold,
            )
        elif self._req_count % 20 == 0:
            logger.info(
                "in-episode: req=%d state_l2=%.3f commits=%d",
                self._req_count, delta, getattr(self, "_commit_count", 0),
            )
        self._last_state = cur_state

        # Commit the PREVIOUS request's staged observation as one history
        # anchor, feeding back the chunk the client executed open-loop.
        # override_pending_action_chunk expects raw [K, model_n_dims];
        # commit_observation for a GAM model must be called with exactly 1
        # (model steps, not env actions) — anything else wipes history
        # (eval_libero_unified.py:4020, :4040-4049, reference loop :5553-5575).
        if self._use_history and self._prev_returned_chunk is not None:
            self.policy.override_pending_action_chunk(
                torch.from_numpy(self._prev_returned_chunk)
            )
            self.policy.commit_observation(1)
            self._commit_count = getattr(self, "_commit_count", 0) + 1

        with torch.no_grad():
            act = self.policy(closure_obs, prompt)
        act_full = np.asarray(
            act.reshape(-1, self.model_n_dims).float().cpu().numpy(), dtype=np.float32
        )
        horizon = int(self.info.get("chunk_size") or act_full.shape[0])
        act_full = np.ascontiguousarray(act_full[:horizon], dtype=np.float32)
        # Stage the full-dim raw chunk as next request's executed past action.
        # The client replans after ~replan_ratio*chunk_size of it, but the
        # trained commit stride is one model step regardless
        # (eval_libero_unified.py:3459), so feeding the full chunk is the
        # closest server-side approximation.
        if self._use_history:
            self._prev_returned_chunk = act_full
        out = act_full[:, : self.d_out]  # slice dual layout -> single-arm block when needed
        if self._delta_mode:
            # Anchor is the CURRENT request's raw state (pre-padding), matching
            # the loader's per-chunk observation-frame anchoring; p22 (single,
            # 23->22) or p44 (dual, 46->44) per the checkpoint layout.
            p = self._proprio_to_p(
                np.asarray(obs["state"], dtype=np.float32).reshape(-1)
            ).astype(np.float32)
            out = out + p[None, : out.shape[1]]
        return {"actions": np.ascontiguousarray(out, dtype=np.float32)}


class WebsocketPolicyServer:
    def __init__(self, policy, host: str, port: int, metadata: dict | None = None):
        self._policy = policy
        self._host = host
        self._port = port
        self._metadata = metadata or {}

    def serve_forever(self):
        asyncio.run(self.run())

    async def run(self):
        async with _server.serve(
            self._handler,
            self._host,
            self._port,
            compression=None,
            max_size=None,
            ping_interval=None,
            ping_timeout=None,
            process_request=_health_check,
        ) as server:
            await server.serve_forever()

    async def _handler(self, ws):
        logger.info("Connection from %s opened", ws.remote_address)
        packer = msgpack_numpy.Packer()
        await ws.send(packer.pack(self._metadata))
        while True:
            try:
                obs = msgpack_numpy.unpackb(await ws.recv())
                # Worker thread, NOT inline: the first get_action can spend
                # minutes in torch.compile / DA3 warmup, and blocking the event
                # loop there leaves the client's keepalive unanswered.
                action = await asyncio.to_thread(self._policy.infer, obs)
                await ws.send(packer.pack(action))
            except websockets.ConnectionClosed:
                logger.info("Connection from %s closed", ws.remote_address)
                break
            except Exception:
                await ws.send(traceback.format_exc())
                await ws.close(
                    code=websockets.frames.CloseCode.INTERNAL_ERROR,
                    reason="Internal server error. Traceback included in previous frame.",
                )
                raise


def _health_check(connection, request):
    if request.path == "/healthz":
        return connection.respond(http.HTTPStatus.OK, "OK\n")
    return None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint-path", required=True,
                    help="Submission checkpoint dir (holds checkpoint-final.pt + config.yaml) or a direct .pt path.")
    ap.add_argument("--embodiment-tag", required=True, choices=sorted(_TAG_ACTION_DIM))
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    args = ap.parse_args()

    policy = GamDexJoCoPolicy(args.checkpoint_path, args.embodiment_tag, args.prompt)
    server = WebsocketPolicyServer(policy, args.host, args.port)
    logger.info("serving GAM DexJoCo policy on %s:%d", args.host, args.port)
    server.serve_forever()
