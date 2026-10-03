"""Command-line entry point: `python -m screen_copilot hover|watch ...`."""

import argparse

from . import hover, watch
from .capture import Region


def main() -> None:
    p = argparse.ArgumentParser(prog="screen-copilot", description="AI that looks at your screen.")
    p.add_argument("--lang", default="Traditional Chinese", help="language for descriptions (default: Traditional Chinese)")
    sub = p.add_subparsers(dest="cmd", required=True)

    h = sub.add_parser("hover", help="read and explain whatever is under the mouse")
    h.add_argument("--dwell", type=float, default=0.8, help="seconds the mouse must rest before reading")
    h.add_argument("--box", default="700x450", help="capture size around the cursor, WxH in points")
    h.add_argument("--notify", action="store_true", help="also show a desktop notification")

    w = sub.add_parser("watch", help="watch a screen region and notify on changes/errors")
    w.add_argument("--region", type=Region.parse, help="x,y,width,height in points (omit to pick with the mouse)")
    w.add_argument(
        "--when",
        default="the task finishes, fails, shows an error (e.g. red text or an error dialog), or stalls",
        help="plain-language condition to alert on",
    )
    w.add_argument("--interval", type=float, default=2.0, help="seconds between local screenshots")
    w.add_argument("--threshold", type=float, default=1.5, help="pixel change (0-255) that triggers an AI check")
    w.add_argument("--heartbeat", type=float, default=300, help="force an AI check every N seconds (0 = never)")
    w.add_argument("--once", action="store_true", help="exit after the first notification")

    args = p.parse_args()
    try:
        if args.cmd == "hover":
            bw, bh = (int(v) for v in args.box.lower().split("x"))
            hover.run(args.dwell, bw, bh, args.lang, args.notify)
        else:
            region = args.region or watch.pick_region()
            watch.run(region, args.when, args.interval, args.threshold, args.heartbeat, args.lang, args.once)
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
