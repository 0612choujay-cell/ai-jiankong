"""Desktop notifications (macOS via osascript; falls back to the terminal bell elsewhere)."""

import json
import platform
import subprocess
import sys


def notify(title: str, message: str, sound: bool = True) -> None:
    if platform.system() == "Darwin":
        script = f"display notification {json.dumps(message[:240])} with title {json.dumps(title)}"
        if sound:
            script += ' sound name "Glass"'
        subprocess.run(["osascript", "-e", script], check=False)
    elif platform.system() == "Linux":
        subprocess.run(["notify-send", title, message], check=False)
    else:
        sys.stdout.write("\a")
        sys.stdout.flush()
