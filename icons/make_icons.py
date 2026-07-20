"""Generate PNG icons for SajiPlan PWA — fork + spoon mark, terracotta on cream."""
import os
from PIL import Image, ImageDraw

PAPER = (244, 236, 224, 255)
INK = (36, 28, 22, 255)
ACCENT = (191, 77, 31, 255)
OUT = os.path.dirname(os.path.abspath(__file__))


def draw_icon(size, maskable=False):
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(s * 0.20)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=PAPER)

    # inner frame (skip on maskable to respect safe zone)
    if not maskable:
        m = s * 0.05
        d.rounded_rectangle([m, m, s - m, s - m], radius=int(s * 0.16),
                            outline=INK, width=max(2, int(s * 0.018)))

    # geometry, pulled inward for maskable safe zone
    inset = 0.12 if maskable else 0.0
    lw = max(3, int(s * (0.045 if not maskable else 0.05)))
    top = s * (0.24 + inset)
    bot = s * (0.78 - inset)
    midx = s * 0.5

    fx = s * (0.36 + inset * 0.6)   # fork x
    sx = s * (0.64 - inset * 0.6)   # spoon x

    # Fork: stem + two tines via an arc-ish prong using lines
    d.line([(fx, top), (fx, bot)], fill=ACCENT, width=lw)
    tine_top = top - s * 0.02
    prong_bottom = top + s * 0.15
    d.line([(fx - s * 0.05, tine_top), (fx - s * 0.05, prong_bottom)], fill=ACCENT, width=lw)
    d.line([(fx + s * 0.05, tine_top), (fx + s * 0.05, prong_bottom)], fill=ACCENT, width=lw)
    d.arc([fx - s * 0.05, prong_bottom - s * 0.04, fx + s * 0.05, prong_bottom + s * 0.04],
          0, 180, fill=ACCENT, width=lw)

    # Spoon: stem + bowl (ellipse outline)
    d.line([(sx, top + s * 0.16), (sx, bot)], fill=ACCENT, width=lw)
    bowl_r = s * 0.075
    d.ellipse([sx - bowl_r, top - s * 0.01, sx + bowl_r, top + s * 0.17],
              outline=ACCENT, width=lw)

    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    for name, size, mask in [("icon-192.png", 192, False), ("icon-512.png", 512, False), ("icon-maskable.png", 512, True)]:
        draw_icon(size, mask).save(os.path.join(OUT, name))
        print("wrote", name)


if __name__ == "__main__":
    main()
