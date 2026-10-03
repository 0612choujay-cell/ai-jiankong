"""Claude vision calls: what is under the cursor, and what state is a watched region in."""

import json
from typing import Any, Dict, Optional

import anthropic
from PIL import Image

from .capture import to_base64_png

MODEL = "claude-opus-5-5"

_client: Optional[anthropic.Anthropic] = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # ANTHROPIC_API_KEY or `ant auth login` profile
    return _client


class RefusalError(RuntimeError):
    pass


def _ask_json(img: Image.Image, prompt: str, schema: Dict[str, Any], effort: str) -> Dict[str, Any]:
    response = client().beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        # If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": to_base64_png(img)},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise RefusalError(f"request declined (category: {category})")
    text = "".join(b.text for b in response.content if b.type == "text")
    return json.loads(text)


# ---------------------------------------------------------------------------
# Feature 1: UI grounding - read whatever is under the mouse
# ---------------------------------------------------------------------------

HOVER_SCHEMA = {
    "type": "object",
    "properties": {
        "element_type": {
            "type": "string",
            "description": "paragraph, heading, image, product, table, chart, button, link, input, menu, icon, code, video, other",
        },
        "label": {"type": "string", "description": "Short name of the element, e.g. 'Add to cart button'"},
        "text": {"type": "string", "description": "Verbatim visible text of the element (table: rows as 'a | b | c')"},
        "meaning": {"type": "string", "description": "What the element means or does, in 1-3 sentences"},
    },
    "required": ["element_type", "label", "text", "meaning"],
    "additionalProperties": False,
}


def describe_under_cursor(img: Image.Image, cursor: tuple, language: str) -> Dict[str, Any]:
    prompt = (
        f"This is a screenshot crop. The mouse cursor is at pixel ({cursor[0]}, {cursor[1]}), "
        "marked with a magenta ring and crosshair (the marker is not part of the UI).\n"
        "Identify the single UI element the cursor is pointing at - the whole paragraph, "
        "product card/image, table, or button, not just one word. Transcribe its visible "
        "text exactly and explain what it means or does. "
        "If it is an image or product, describe what it shows and any name/price nearby. "
        f"Write label and meaning in {language}; keep text verbatim."
    )
    return _ask_json(img, prompt, HOVER_SCHEMA, effort="low")


# ---------------------------------------------------------------------------
# Feature 2: watch a screen region and decide whether to alert
# ---------------------------------------------------------------------------

WATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "state": {"type": "string", "description": "One-line description of what the region shows now"},
        "status": {
            "type": "string",
            "enum": ["running", "idle", "done", "error", "warning", "unknown"],
        },
        "progress_percent": {
            "type": ["number", "null"],
            "description": "Progress 0-100 if a progress indicator is visible, else null",
        },
        "should_notify": {
            "type": "boolean",
            "description": "True if the user should be alerted right now, per their watch condition",
        },
        "reason": {"type": "string", "description": "Why notify (or empty string)"},
    },
    "required": ["state", "status", "progress_percent", "should_notify", "reason"],
    "additionalProperties": False,
}


def assess_region(img: Image.Image, condition: str, previous_state: Optional[str], language: str) -> Dict[str, Any]:
    prompt = (
        "You are monitoring a region of the user's screen (e.g. a progress bar, render "
        "preview, terminal, build log or error dialog) while they do something else.\n"
        f"User's watch condition: {condition}\n"
        f"Previous state: {previous_state or '(first look)'}\n"
        "Describe the current state. Set should_notify=true only when something the user "
        "would want to know about just happened relative to the previous state - for example "
        "an error, red error text, a crash or warning dialog, the task finishing, or the "
        "condition above being met. Do not notify for ordinary progress ticks. "
        f"Write state and reason in {language}."
    )
    return _ask_json(img, prompt, WATCH_SCHEMA, effort="medium")
