# Screen Copilot

An AI that **looks at your screen** and understands what it shows, using screenshots and Claude vision. It reads pixels, so it works in any app: browsers, PDFs, design tools, remote desktops and games. It doesn't need DOM access, accessibility APIs or app integrations.

讓 AI 直接「看」螢幕：不依賴軟體底層代碼，任何介面都能讀懂。

| Feature | 功能 | What it does |
|---|---|---|
| `hover` | **視覺語意理解（UI Grounding）**：跨介面元素對齊 | Follows your mouse. When the mouse rests on a paragraph, product image, table or button, the AI reads that block's text and explains what it means. |
| `watch` | **螢幕區域監控**：讓 AI 幫忙「盯著」螢幕 | Watches a screen region you choose, such as a progress bar, render preview, build log or terminal. When the state changes (finished, failed, red error text appeared), it sends a desktop notification. |

## How it works

```
hover:  mouse rests ─▶ screenshot box around cursor ─▶ draw marker at cursor ─▶ Claude: "what element is under the marker?" ─▶ label / verbatim text / meaning
watch:  every N s screenshot region ─▶ cheap local pixel diff + red-pixel spike detector
                                         └─ changed? ─▶ Claude: "what state is this, should the user be alerted?" ─▶ 🔔 notification
```

- To save cost, a local pixel diff decides **when** to look, and Claude is only called when the region actually changes. A sudden jump in red pixels, which usually means error text appeared, triggers an immediate check.
- Claude returns **structured JSON** (`output_config.format`), so parsing is reliable.
- Model: `claude-opus-5-5`. `hover` runs at `low` effort for latency and `watch` runs at `medium`.
- Server-side refusal fallbacks (`fallbacks: "default"`) are enabled.

## Install

Requires Python 3.9+ and an Anthropic API key.

```bash
git clone https://github.com/<you>/screen-copilot.git
cd screen-copilot
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
export ANTHROPIC_API_KEY=sk-ant-...
```

**macOS permissions:** go to System Settings → Privacy & Security and grant your terminal app (Terminal, iTerm, VS Code…):
- **Screen Recording**, which is needed to take screenshots
- **Accessibility**, which is needed to read the mouse position

Restart the terminal after granting them.

## Usage

### 1. Hover: read whatever is under the mouse

```bash
screen-copilot hover
screen-copilot hover --dwell 1.2 --box 900x600 --notify
screen-copilot --lang English hover
```

Example output:

```
▶ 加入購物車按鈕  (button)  @ (812, 433)
  文字 text   : Add to Cart
  意義 meaning: 將目前頁面的商品（$49.99 無線耳機）加入購物車。
```

### 2. Watch: monitor a region and notify

```bash
# pick the region with the mouse (top-left, Enter, bottom-right, Enter)
screen-copilot watch

# or give it directly (x,y,width,height in points; printed after picking)
screen-copilot watch --region 0,600,1440,300

# custom condition in plain language
screen-copilot watch --region 300,200,800,60 --when "the render progress bar reaches 100%"
screen-copilot watch --when "the build log prints FAILED or any red error text" --once
```

| Option | Default | Meaning |
|---|---|---|
| `--interval` | `2` | Seconds between local screenshots. These are free and don't call the API. |
| `--threshold` | `1.5` | Mean pixel change (0–255) needed before an AI check |
| `--heartbeat` | `300` | Force an AI check every N seconds, even if nothing changes, to catch stalls. Set to `0` to turn it off. |
| `--once` | off | Exit after the first notification |

## Cost notes

- Each AI check sends one screenshot, which costs roughly 1–2K input tokens depending on its size.
- `hover` skips a call when the mouse rests on something it just read.
- `watch` only calls Claude when pixels change, and a progress bar that ticks constantly will trigger often. To reduce calls, raise `--threshold` or `--interval`, or select a smaller region.

## Project layout

```
screen_copilot/
  capture.py   screenshots (mss), cursor position, change & red-text detection
  vision.py    Claude calls + JSON schemas
  hover.py     feature 1 – UI grounding loop
  watch.py     feature 2 – region watcher loop
  notify.py    macOS / Linux desktop notifications
  __main__.py  CLI
```

## Privacy

Screenshots of the selected area are sent to the Anthropic API. Don't watch or hover over content you can't share, such as passwords or private messages.
