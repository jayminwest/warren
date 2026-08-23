#!/usr/bin/env python3
"""Generate the warren logo: an agent-workload network + wordmark.

Concept: Warren turns coding agents into infrastructure. The mark is a
hexagonal cluster of isolated agent workloads connected to a larger
infrastructure kernel. One bright outer node and spoke suggest an active run.

Outputs:
  branding/logo.png             horizontal mark + wordmark (~640x220)
  branding/logo@2x.png          same at 2x for retina
  branding/icon.png             square mark only (256x256), for avatars/favicons
  branding/logo-alpha.png       horizontal lockup on a TRANSPARENT canvas
  branding/logo-alpha@2x.png    same at 2x for retina
  branding/icon-alpha.png       square mark only, transparent (256x256)

The three original outputs render on an opaque `BG` canvas and are keyed to
a DARK surface. That is right for the README banner on GitHub and for
avatars, and their bytes are deliberately unchanged by the alpha work below
— a transparent README banner would render light-gray-on-white and vanish.

The `-alpha` outputs exist for surfaces that supply their own background
and may be either theme: a favicon on a light or dark tab strip, an icon
composited onto a page. They drop the canvas fill and swap the dark-keyed
palette for `DUOTONE`, whose mid-grays clear 3:1 contrast against both
white and near-black. Consumers that know their background is dark should
keep using the opaque files.
"""

import math
from PIL import Image, ImageDraw, ImageFont

# --- Palette: match the warren UI (src/ui/src/index.css dark mode) ---
# Cool neutrals plus Warren's single muted-green brand accent. The center uses
# the dark-theme primary from warren-site: oklch(72% 0.11 152).
BG = (24, 25, 28)              # --color-bg            oklch(14% 0.005 264)
FG = (242, 244, 248)           # --color-fg            oklch(96% 0.005 264)
PRIMARY = (108, 184, 130)      # --color-primary       oklch(72% 0.11 152)
MUTED_FG = (160, 162, 168)     # --color-muted-fg      oklch(67% 0.01 264)
BORDER = (62, 64, 70)          # --color-border        oklch(28% 0.01 264)

# Mark-specific roles:
EDGE = BORDER                  # outer-to-outer tunnel edges (dim)
NODE_INACTIVE = MUTED_FG       # idle outer nodes + their spokes
NODE_ACTIVE = FG               # active run: bright
CENTER = PRIMARY               # infrastructure kernel
TEXT_PRIMARY = FG
TEXT_DIM = MUTED_FG

# One role -> color map, so a renderer can be handed a palette instead of
# reading the module constants directly. DARK is exactly the mapping above.
DARK = {
    "bg": BG,
    "edge": EDGE,
    "node_inactive": NODE_INACTIVE,
    "node_active": NODE_ACTIVE,
    "center": CENTER,
    "text": TEXT_PRIMARY,
    "text_dim": TEXT_DIM,
}

# Background-agnostic palette for the `-alpha` outputs. Neutral values sit in
# the middle of the ramp so the mark reads on white and on near-black. The
# green center uses the midpoint between warren-site's light and dark primary
# tokens so it remains visible on either surface.
DUOTONE = {
    "bg": (0, 0, 0, 0),
    "edge": (139, 141, 148),
    "node_inactive": (122, 124, 131),
    "node_active": (90, 92, 99),
    "center": (90, 162, 111),
    "text": (90, 92, 99),
    "text_dim": (122, 124, 131),
}

SCALE = 4  # render at 4x then downsample for crisp edges

# --- Horizontal layout (1x units) ---
IMG_W = 640
IMG_H = 220

MARK_CX = 110
MARK_CY = 110
HEX_RADIUS = 64                # center -> outer node distance
NODE_RADIUS = 8
CENTER_HALF = 14               # half-side of center rounded square
CENTER_RADIUS = 5              # corner radius of center square
LINE_WIDTH = 2

TEXT_X = 230
NAME = "warren"
TAGLINE = "coding agents into infrastructure"
NAME_SIZE = 56
TAG_SIZE = 16
NAME_Y = 76
TAG_Y = 142

ACTIVE_OUTER = 1               # index of the bright node (0=top, going clockwise)


def load_font(path: str, size: int):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def hex_positions(cx: float, cy: float, r: float):
    """6 nodes around (cx, cy), pointed-top hex."""
    angles_deg = [-90, -30, 30, 90, 150, 210]
    return [
        (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
        for a in angles_deg
    ]


def draw_mark(draw: ImageDraw.ImageDraw, cx: float, cy: float, s: int, palette=DARK):
    """Draw the workload-network mark centered at (cx, cy). s = SCALE."""
    outer = hex_positions(cx, cy, HEX_RADIUS)
    lw = LINE_WIDTH * s

    # 1. tunnel ring: connect each outer node to its neighbors
    for i in range(6):
        x1, y1 = outer[i]
        x2, y2 = outer[(i + 1) % 6]
        draw.line(
            [x1 * s, y1 * s, x2 * s, y2 * s],
            fill=palette["edge"],
            width=lw,
        )

    # 2. spokes: center -> each outer node
    for i, (x, y) in enumerate(outer):
        color = palette["node_active"] if i == ACTIVE_OUTER else palette["node_inactive"]
        draw.line(
            [cx * s, cy * s, x * s, y * s],
            fill=color,
            width=lw,
        )

    # 3. outer nodes
    nr = NODE_RADIUS * s
    for i, (x, y) in enumerate(outer):
        color = palette["node_active"] if i == ACTIVE_OUTER else palette["node_inactive"]
        draw.ellipse(
            [x * s - nr, y * s - nr, x * s + nr, y * s + nr],
            fill=color,
        )

    # 4. infrastructure kernel — solid rounded square in primary gray
    ch = CENTER_HALF * s
    cr = CENTER_RADIUS * s
    draw.rounded_rectangle(
        [cx * s - ch, cy * s - ch, cx * s + ch, cy * s + ch],
        radius=cr,
        fill=palette["center"],
    )


def new_canvas(w: int, h: int, palette):
    """A canvas in the mode the palette implies: RGBA iff `bg` has alpha."""
    mode = "RGBA" if len(palette["bg"]) == 4 else "RGB"
    return Image.new(mode, (w, h), palette["bg"])


def render_horizontal(out_path: str, w: int, h: int, s: int, palette=DARK, retina: bool = False):
    """Mark + wordmark. `retina` downsamples 4x -> 2x instead of 4x -> 1x."""
    img = new_canvas(w * s, h * s, palette)
    draw = ImageDraw.Draw(img)

    draw_mark(draw, MARK_CX, MARK_CY, s, palette)

    name_font = load_font("/System/Library/Fonts/HelveticaNeue.ttc", NAME_SIZE * s)
    tag_font = load_font("/System/Library/Fonts/SFNSMono.ttf", TAG_SIZE * s)

    draw.text((TEXT_X * s, NAME_Y * s), NAME, fill=palette["text"], font=name_font)
    draw.text((TEXT_X * s, TAG_Y * s), TAGLINE, fill=palette["text_dim"], font=tag_font)

    factor = 2 if retina else 1
    out_w, out_h = w * factor, h * factor
    img = img.resize((out_w, out_h), Image.LANCZOS)
    img.save(out_path)
    print(f"Saved {out_path} ({out_w}x{out_h})")


def render_icon(out_path: str, size: int, s: int, palette=DARK):
    """Square icon — just the mark, centered."""
    img = new_canvas(size * s, size * s, palette)
    draw = ImageDraw.Draw(img)
    # center the mark inside the square
    draw_mark(draw, size / 2, size / 2, s, palette)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(out_path)
    print(f"Saved {out_path} ({size}x{size})")


if __name__ == "__main__":
    import os

    out_dir = os.path.dirname(os.path.abspath(__file__))

    def out(name: str) -> str:
        return os.path.join(out_dir, name)

    # Opaque, dark-keyed. Bytes must not change: the README banner and the
    # org avatar point at these.
    render_horizontal(out("logo.png"), IMG_W, IMG_H, SCALE)
    render_horizontal(out("logo@2x.png"), IMG_W, IMG_H, SCALE, retina=True)
    render_icon(out("icon.png"), 256, SCALE)

    # Transparent, background-agnostic. For favicons and for compositing
    # onto a surface whose theme this script cannot know.
    render_horizontal(out("logo-alpha.png"), IMG_W, IMG_H, SCALE, palette=DUOTONE)
    render_horizontal(out("logo-alpha@2x.png"), IMG_W, IMG_H, SCALE, palette=DUOTONE, retina=True)
    render_icon(out("icon-alpha.png"), 256, SCALE, palette=DUOTONE)
