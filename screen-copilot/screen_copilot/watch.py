"""Feature 2 - 跨介面狀態監控 / screen-region watcher.

Watch a fixed region (progress bar, render preview, terminal, build log). A cheap
local pixel diff decides *when* to look; Claude decides *what* changed and whether
to alert. A sudden jump in red pixels (error text) triggers a look immediately.
"""

import time
from typing import Optional

import anthropic

from . import capture, vision
from .notify import notify


def pick_region() -> capture.Region:
    input("Move the mouse to the TOP-LEFT corner of the area to watch, then press Enter...")
    x1, y1 = capture.mouse_position()
    input("Move the mouse to the BOTTOM-RIGHT corner, then press Enter...")
    x2, y2 = capture.mouse_position()
    region = capture.Region(min(x1, x2), min(y1, y2), abs(x2 - x1) or 1, abs(y2 - y1) or 1)
    print(f"Region: {region}   (reuse with --region {region})")
    return region


def run(
    region: capture.Region,
    condition: str,
    interval: float,
    change_threshold: float,
    heartbeat: float,
    language: str,
    once: bool,
) -> None:
    print(f"Watching {region} every {interval}s. Condition: {condition}\nCtrl+C to stop.\n")
    last_fp = None
    last_red: Optional[float] = None
    last_check = 0.0
    previous_state: Optional[str] = None

    while True:
        img = capture.grab(region)
        fp = capture.fingerprint(img)
        red = capture.red_ratio(img)

        changed = last_fp is None or capture.difference(fp, last_fp) >= change_threshold
        red_spike = last_red is not None and red - last_red > 0.003
        stale = heartbeat > 0 and time.monotonic() - last_check > heartbeat

        if changed or red_spike or stale:
            last_fp, last_red, last_check = fp, red, time.monotonic()
            try:
                result = vision.assess_region(img, condition, previous_state, language)
            except vision.RefusalError as e:
                print(f"[skipped] {e}")
            except anthropic.RateLimitError:
                print("[rate limited] backing off 30s")
                time.sleep(30)
                continue
            except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
                print(f"[api error] {e}")
            else:
                stamp = time.strftime("%H:%M:%S")
                pct = result["progress_percent"]
                pct_txt = f" {pct:.0f}%" if isinstance(pct, (int, float)) else ""
                print(f"[{stamp}] {result['status']}{pct_txt} - {result['state']}")
                if result["should_notify"] or (red_spike and result["status"] == "error"):
                    title = f"Screen Copilot: {result['status'].upper()}"
                    notify(title, result["reason"] or result["state"])
                    print(f"           🔔 {result['reason']}")
                    if once:
                        return
                previous_state = f"{result['status']}: {result['state']}"
        time.sleep(interval)
