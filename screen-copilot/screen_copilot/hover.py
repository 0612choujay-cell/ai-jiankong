"""Feature 1 - 視覺語意理解 / UI grounding.

Follow the mouse; when it rests on something, screenshot the area around it and
ask Claude what element is under the cursor and what it says/means. Works on any
app (browser, PDF, image, remote desktop) because it only looks at pixels.
"""

import math
import time

import anthropic

from . import capture, vision
from .notify import notify


def run(dwell: float, box_w: int, box_h: int, language: str, show_notification: bool) -> None:
    print(f"Hover mode - rest the mouse for {dwell}s on anything to read it. Ctrl+C to quit.\n")
    last_pos = capture.mouse_position()
    still_since = time.monotonic()
    last_fp = None
    handled = False

    while True:
        time.sleep(0.1)
        pos = capture.mouse_position()
        if math.dist(pos, last_pos) > 4:
            last_pos, still_since, handled = pos, time.monotonic(), False
            continue
        if handled or time.monotonic() - still_since < dwell:
            continue
        handled = True

        img, cursor = capture.grab_around_cursor(box_w, box_h)
        fp = capture.fingerprint(img)
        if last_fp is not None and capture.difference(fp, last_fp) < 1.0:
            continue  # same thing as last time, don't pay for it twice
        last_fp = fp

        try:
            result = vision.describe_under_cursor(img, cursor, language)
        except vision.RefusalError as e:
            print(f"[skipped] {e}")
            continue
        except anthropic.RateLimitError:
            print("[rate limited] waiting 10s")
            time.sleep(10)
            continue
        except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
            print(f"[api error] {e}")
            continue

        print(f"▶ {result['label']}  ({result['element_type']})  @ {pos}")
        if result["text"]:
            print(f"  文字 text   : {result['text']}")
        print(f"  意義 meaning: {result['meaning']}\n")
        if show_notification:
            notify(result["label"], result["meaning"], sound=False)
