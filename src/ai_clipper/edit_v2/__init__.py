"""Editor V3 Esensial: the single clip-edit-v2 resolver and compiler (plan §2.1 E1, Appendix A).

Everything in this package is standard-library Python. The contracts of every module are frozen
in ``docs/editor/CONTRACTS.md`` (plan Appendix A, §3, §4.2 and §4.3). The constants below are
shared by several tasks (validator T1.1, packs T1.2a, seed T1.5, commands T2.5) so that none of
them has to wait for another to learn them.
"""

from types import MappingProxyType

COMPILER_VERSION = "edit-v2/1.0.0"  # semver of the compiler; part of every render key (R9)
COMPILER_ID = "edit-v2/1"  # the plan DTO field "compiler" and base.engine.compiler
# Bump on any golden-pixel change (owner look approval). 2: the karaoke \kf sweep and the
# Sinar pack (CONTRACTS §5.49).
RENDER_SEMANTICS = 2

SCHEMA = "clip-edit-v2"
SCHEMA_MINOR = 0
WORDS_SCHEMA = "potongin.words/1"
CAMERA_SCHEMA = "potongin.camera-plan/1"

# Plan §3.1 and §3.3: the only document frame rates and output sizes: 9:16 and 1:1 (CONTRACTS
# §5.54), each at 720 and 1080 wide.
DOC_FPS = ((24, 1), (25, 1), (30, 1), (24000, 1001), (30000, 1001))
OUTPUT_SIZES = ((720, 1280), (1080, 1920), (720, 720), (1080, 1080))

# Plan §3.3: caption packs and the colour swatches of ``highlight`` and ``emphasis``. ``sorot``
# (a box behind the spoken word) came with "Kata per baris" (CONTRACTS §5.30), ``sinar`` (the
# karaoke sweep with a soft glow) with the karaoke sweep (CONTRACTS §5.49).
PACK_IDS = ("classic", "karaoke", "bold", "box", "sorot", "sinar")
SWATCHES = ("#FFE14D", "#FFFFFF", "#3DF5A6", "#52C7FF", "#FF5C8A", "#FF9F1C")
# The optional override ``words_max`` ("Kata per baris"): absent means the pack's words_per_cue.
WORDS_MAX_RANGE = (1, 4)
# The optional override ``entrance`` ("Animasi masuk", CONTRACTS §5.39): absent means "none".
CAPTION_ENTRANCES = ("none", "fade", "pop", "blur")
# The caption's positions Atas, Tengah and Bawah (``captions.overrides.y_e5``, the block's
# bottom), as the editor's Posisi pills offer them; the caption-over-face check moves the caption
# to one of these (CONTRACTS §5.50).
CAPTION_PRESETS = (("atas", 38000), ("tengah", 60000), ("bawah", 83000))
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
# TikTok UI zone at 720×1280 (plan §5.9 G5): top, bottom, right; scaled to other 9:16 sizes. A
# 1:1 clip has no zone (CONTRACTS §5.54): see ui_zone below.
UI_ZONE_720 = (93, 280, 93)
# The left margin of a logo preset and of the text watermark, per mille of the width; a 1:1 clip
# keeps it on every side (frame_margins).
EDGE_MARGIN_PM = 40
# Manual framing, "Atur bingkai" (optional ``layout.keyframes``, CONTRACTS §5.44): how the crop
# reaches a keyframe from the one before ("Potong" / "Geser"), at most this many keyframes, and
# ``pan_e5`` from 0 (crop at the left edge) to PAN_E5_MAX (at the right edge).
KEYFRAME_MOVES = ("cut", "slide")
MAX_KEYFRAMES = 100
PAN_E5_MAX = 100_000
# Layar terbagi (``layout.default.mode: "split"`` with ``layout.split``, CONTRACTS §5.45): the top
# band's share of the rows beside the 1 px line, per mille (30/70, 50/50, 30/70 swapped), the
# bands, and each band's zoom from the largest band-shaped box of the source (1000) to 5×.
SPLIT_TOP_PM = (300, 500, 700)
SPLIT_BANDS = ("top", "bottom")
SPLIT_ZOOM_RANGE = (1000, 5000)
# Otomatis (``layout.ranges``, CONTRACTS §5.63): whether an automatic range may be a split. The
# split chain needs the graph spike of rombak 04 §A7.2 (``scripts/parity/auto_graph_spike.py``);
# until it passes, a split range is ``op_disabled`` and two speakers in a wide shot are followed
# by face-track.
AUTO_SPLIT = False
# Zoom (optional ``layout.zoom_pm``, CONTRACTS §5.52): the picture of every layout but the split
# enlarged from 1000 (absent: today's picture) to 1.5×, per mille.
ZOOM_RANGE = (1000, 1500)

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
# The caption spot and size a new job picks on the dashboard (CONTRACTS §5.48): the seed's
# ``y_e5`` and ``size_pm``, equal to the editor's "Posisi" and "Ukuran" presets. Bottom and
# medium are the pack defaults above.
CAPTION_POSITIONS = MappingProxyType({"top": 38000, "middle": 60000, "bottom": 83000})
CAPTION_SIZES = MappingProxyType({"small": 850, "medium": 1000, "large": 1200})

def _half_up(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def portrait(output: tuple[int, int]) -> bool:
    """True for a 9:16 output size, false for 1:1."""
    return output[1] > output[0]


def ui_zone(output: tuple[int, int]) -> tuple[int, int, int]:
    """(top, bottom, right) of the TikTok UI zone in output pixels (plan §5.9 G5): 93/280/93 at
    720×1280 scaled with the height and the width; none at 1:1 (CONTRACTS §5.54)."""
    width, height = output
    if not portrait(output):
        return (0, 0, 0)
    top, bottom, right = UI_ZONE_720
    return (_half_up(top * height, 1280), _half_up(bottom * height, 1280),
            _half_up(right * width, 720))


def frame_margins(output: tuple[int, int]) -> tuple[int, int, int]:
    """(top, bottom, right) a logo preset and the text watermark keep from the frame's edges:
    the TikTok zone at 9:16, the 4 % left margin on every side at 1:1 (CONTRACTS §5.54)."""
    if portrait(output):
        return ui_zone(output)
    margin = _half_up(output[0] * EDGE_MARGIN_PM, 1000)
    return (margin, margin, margin)


def text_height(output: tuple[int, int]) -> int:
    """The height text is sized from (captions, hook, watermark): the output height at 9:16, the
    height of the 9:16 frame of the same width at 1:1, so a 1:1 clip's text is as large as the
    9:16 clip's of its width (CONTRACTS §5.54)."""
    width, height = output
    return max(height, _half_up(16 * width, 9))


__all__ = [
    "AUTO_SPLIT",
    "CAMERA_SCHEMA",
    "CAPTION_ENTRANCES",
    "CAPTION_POSITIONS",
    "CAPTION_PRESETS",
    "CAPTION_SIZES",
    "COMPILER_ID",
    "COMPILER_VERSION",
    "DOC_FPS",
    "EDGE_MARGIN_PM",
    "HOOK_DESIGN_IDS",
    "KEYFRAME_MOVES",
    "MAX_KEYFRAMES",
    "OUTPUT_SIZES",
    "PACK_DEFAULT_OVERRIDES",
    "PACK_IDS",
    "PAN_E5_MAX",
    "RENDER_SEMANTICS",
    "SCHEMA",
    "SCHEMA_MINOR",
    "SPLIT_BANDS",
    "SPLIT_TOP_PM",
    "SPLIT_ZOOM_RANGE",
    "SWATCHES",
    "UI_ZONE_720",
    "WATERMARK_OPACITY_RANGE",
    "WATERMARK_POSITIONS",
    "WATERMARK_SIZE_RANGE",
    "WATERMARK_TEXT_MAX",
    "WORDS_MAX_RANGE",
    "WORDS_SCHEMA",
    "ZOOM_RANGE",
    "frame_margins",
    "portrait",
    "text_height",
    "ui_zone",
]
