---
name: DeepSeek API model names
description: Valid model name strings for the DeepSeek API and tool_choice constraint
---

## Valid model names (as of July 2026)

| Intent | Model string | Notes |
|---|---|---|
| V3 (fast chat/generation) | `deepseek-v4-pro` | Was `deepseek-chat` — that name is now rejected |
| V3 fast/cheap variant | `deepseek-v4-flash` | Lighter version of V3 |
| R1 (reasoner) | `deepseek-reasoner` | Still valid, unchanged |

**`deepseek-chat` is no longer a valid model name.** The API returns:
> "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-chat."

## tool_choice constraint

`deepseek-v4-pro` does **not** support `tool_choice` / `mode: "tool"` in `generateObject` calls.
Always use `mode: "json"` for any `generateObject` call that targets `deepSeekModel` (V3).

**Why:** The API returns "Thinking mode does not support this tool_choice" when `mode: "tool"` is passed to V3.

**How to apply:** Before any `generateObject` call using `deepSeekModel`, ensure `mode: "json"` is set, not `mode: "tool"`.
