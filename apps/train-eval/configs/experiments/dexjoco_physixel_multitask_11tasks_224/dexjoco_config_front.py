from gr00t.configs.data.embodiment_configs import register_modality_config
from gr00t.data.embodiment_tags import EmbodimentTag
from gr00t.data.types import (
    ActionConfig,
    ActionFormat,
    ActionRepresentation,
    ActionType,
    ModalityConfig,
)


dexjoco_front_config = {
    "video": ModalityConfig(
        delta_indices=[0],
        modality_keys=["front"],
    ),
    "state": ModalityConfig(
        delta_indices=[0],
        modality_keys=["state"],
    ),
    "action": ModalityConfig(
        delta_indices=list(range(16)),
        modality_keys=["action"],
        action_configs=[
            ActionConfig(
                rep=ActionRepresentation.ABSOLUTE,
                type=ActionType.NON_EEF,
                format=ActionFormat.DEFAULT,
            ),
        ],
    ),
    "language": ModalityConfig(
        delta_indices=[0],
        modality_keys=["annotation.human.task_description"],
    ),
}

# Multi-embodiment DexJoCo: bimanual datasets are state[46]/action[44], single-arm
# datasets are state[23]/action[22]. Each gets its own embodiment tag so stats,
# normalization, and the embodiment-conditioned projectors stay separate. The
# modality keys/horizon are identical, so both tags share this config dict.
register_modality_config(dexjoco_front_config, embodiment_tag=EmbodimentTag.DEXJOCO_DUAL_ARM)
register_modality_config(dexjoco_front_config, embodiment_tag=EmbodimentTag.DEXJOCO_SINGLE_ARM)
