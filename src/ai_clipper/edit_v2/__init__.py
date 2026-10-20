"""Editor V3 Esensial: the single clip-edit-v2 resolver and compiler (plan §2.1 E1, Appendix A).

Everything in this package is standard-library Python. The contracts of every module are frozen
in ``docs/editor/CONTRACTS.md`` (plan Appendix A, §3, §4.2 and §4.3). The constants below are
shared by several tasks (validator T1.1, packs T1.2a, seed T1.5, commands T2.5) so that none of
them has to wait for another to learn them.
"""

from types import MappingProxyType

COMPILER_VERSION = "edit-v2/1.0.0"  # semver of the compiler; part of every render key (R9)
COMPILER_ID = "edit-v2/1"  # the plan DTO field "compiler" and base.engine.compiler
RENDER_SEMANTICS = 1  # bump on any golden-pixel change (owner look approval)

SCHEMA = "clip-edit-v2"
SCHEMA_MINOR = 0
WORDS_SCHEMA = "potongin.words/1"
CAMERA_SCHEMA = "potongin.camera-plan/1"

# Plan §3.1 and §3.3: the only document frame rates and output sizes.
DOC_FPS = ((24, 1), (25, 1), (30, 1), (24000, 1001), (30000, 1001))
OUTPUT_SIZES = ((720, 1280), (1080, 1920))

# Plan §3.3: caption packs and the colour swatches of ``highlight`` and ``emphasis``. ``sorot``
# (a box behind the spoken word) came with "Kata per baris" (CONTRACTS §5.30).
PACK_IDS = ("classic", "karaoke", "bold", "box", "sorot")
SWATCHES = ("#FFE14D", "#FFFFFF", "#3DF5A6", "#52C7FF", "#FF5C8A", "#FF9F1C")
# The optional override ``words_max`` ("Kata per baris"): absent means the pack's words_per_cue.
WORDS_MAX_RANGE = (1, 4)
# The optional override ``entrance`` ("Animasi masuk", CONTRACTS §5.39): absent means "none".
CAPTION_ENTRANCES = ("none", "fade", "pop", "blur")
# Hook designs (resources/hook-designs/<id>/v1.json), every one at v 1: the bar the seeds write,
# then Kicker, Blok and Kotak kata (CONTRACTS §5.33).
HOOK_DESIGN_IDS = ("legacy-bar", "kicker", "blok", "kotak")
# The optional text watermark (CONTRACTS §5.43): one line of at most 40 code points at one of
# nine places inside the TikTok-safe area, its size per mille of H/40 and its opacity.
WATERMARK_TEXT_MAX = 40
WATERMARK_POSITIONS = (
    "top_left", "top_center", "top_right",
    "middle_left", "middle_center", "middle_right",
    "bottom_left", "bottom_center", "bottom_right",
)
WATERMARK_SIZE_RANGE = (500, 2000)
WATERMARK_OPACITY_RANGE = (200, 1000)
# TikTok UI zone at 720×1280 (plan §5.9 G5): top, bottom, right; scaled to other sizes.
UI_ZONE_720 = (93, 280, 93)

# Plan §3.5 ("overrides at the pack defaults") and §5.4: every pack's default overrides. The
# seed builder (T1.5) writes these; the pack files resources/caption-packs/<id>/v1.json (T1.2a)
# must carry exactly these defaults.
PACK_DEFAULT_OVERRIDES = MappingProxyType(
    {
        pack: MappingProxyType(
            {
                "y_e5": 83000,  # bottom of the caption block at 83% = today's 17% margin
                "size_pm": 1000,
                "case": "upper" if pack in ("bold", "sorot") else "asis",
                "highlight": "#FFE14D",  # today's KARAOKE_HIGHLIGHT_COLOR
                "emphasis": "#FF5C8A",
            }
        )
        for pack in PACK_IDS
    }
)

__all__ = [
    "CAMERA_SCHEMA",
    "CAPTION_ENTRANCES",
    "COMPILER_ID",
    "COMPILER_VERSION",
    "DOC_FPS",
    "HOOK_DESIGN_IDS",
    "OUTPUT_SIZES",
    "PACK_DEFAULT_OVERRIDES",
    "PACK_IDS",
    "RENDER_SEMANTICS",
    "SCHEMA",
    "SCHEMA_MINOR",
    "SWATCHES",
    "UI_ZONE_720",
    "WATERMARK_OPACITY_RANGE",
    "WATERMARK_POSITIONS",
    "WATERMARK_SIZE_RANGE",
    "WATERMARK_TEXT_MAX",
    "WORDS_MAX_RANGE",
    "WORDS_SCHEMA",
]
