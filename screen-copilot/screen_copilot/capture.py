"""Screen capture helpers.

Coordinates everywhere in this project are in screen *points* (what the mouse
reports). On Retina displays mss returns 2x pixels, so captures are resized
back to point size before being sent to the model.
"""

import base64
import io
from dataclasses import dataclass
from typing import Tuple

import mss
from PIL import Image, ImageChops, ImageDraw, ImageStat
from pynput.mouse import Controller

_mouse = Controller()


@dataclass(frozen=True)
class Region:
    left: int
    top: int
    width: int
    height: int

    @classmethod
    def parse(cls, text: str) -> "Region":
        left, top, width, height = (int(v) for v in text.split(","))
        return cls(left, top, width, height)

    def __str__(self) -> str:
        return f"{self.left},{self.top},{self.width},{self.height}"


def mouse_position() -> Tuple[int, int]:
    x, y = _mouse.position
    return int(x), int(y)


def screen_bounds() -> Region:
    with mss.mss() as sct:
        m = sct.monitors[0]  # union of all displays
        return Region(m["left"], m["top"], m["width"], m["height"])


def grab(region: Region) -> Image.Image:
    with mss.mss() as sct:
        shot = sct.grab(
            {"left": region.left, "top": region.top, "width": region.width, "height": region.height}
        )
    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    if img.size != (region.width, region.height):
        img = img.resize((region.width, region.height), Image.LANCZOS)
    return img


def grab_around_cursor(width: int, height: int) -> Tuple[Image.Image, Tuple[int, int]]:
    """Capture a box centred on the cursor, clamped to the screen, and mark the cursor.

    Returns the image and the cursor position inside it.
    """
    x, y = mouse_position()
    bounds = screen_bounds()
    left = min(max(x - width // 2, bounds.left), bounds.left + bounds.width - width)
    top = min(max(y - height // 2, bounds.top), bounds.top + bounds.height - height)
    img = grab(Region(left, top, width, height))
    cx, cy = x - left, y - top
    draw_marker(img, cx, cy)
    return img, (cx, cy)


def draw_marker(img: Image.Image, x: int, y: int) -> None:
    """Draw a magenta ring + crosshair so the model knows exactly where the cursor is."""
    d = ImageDraw.Draw(img)
    r = 14
    d.ellipse((x - r, y - r, x + r, y + r), outline=(255, 0, 255), width=3)
    d.line((x - r - 6, y, x - 4, y), fill=(255, 0, 255), width=2)
    d.line((x + 4, y, x + r + 6, y), fill=(255, 0, 255), width=2)
    d.line((x, y - r - 6, x, y - 4), fill=(255, 0, 255), width=2)
    d.line((x, y + 4, x, y + r + 6), fill=(255, 0, 255), width=2)


def to_base64_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def fingerprint(img: Image.Image) -> Image.Image:
    """Small grayscale thumbnail used for cheap change detection."""
    return img.convert("L").resize((64, 64), Image.BILINEAR)


def difference(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute pixel difference (0-255) between two fingerprints."""
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


def red_ratio(img: Image.Image) -> float:
    """Fraction of pixels that are strongly red - a cheap 'error text appeared' signal."""
    small = img.resize((max(1, img.width // 2), max(1, img.height // 2)))
    pixels = small.getdata()
    red = sum(1 for r, g, b in pixels if r > 170 and g < 90 and b < 90)
    return red / len(pixels)
