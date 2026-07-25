---
name: DeepSeek API model names
description: Valid model name strings for the DeepSeek API and tool_choice constraint
---

## Valid model names (as of July 2026)

| Intent | Model string | Notes |
|---|---|---|
| V3 full (chat/generation) | `deepseek-v4-pro` | Was `deepseek-chat` — that name is now rejected |
| V3 fast/cheap | `deepseek-v4-flash` | Used for filter-signal, voice-dna (simple extraction) |
| R1 (reasoner) | `deepseek-reasoner` | Still valid — DO NOT change this |

**`deepseek-chat` is no longer a valid model name.** The API returns:
> "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-chat."

**`deepseek-reasoner` is valid and must stay as R1.** User confirmed it must not be changed.
The production backmatter error ("passed deepseek-reasoner") is a production deployment/API-key access issue — not a code issue.

## tool_choice constraint

`deepseek-v4-pro` does **not** support `tool_choice` / `mode: "tool"` in `generateObject` calls.
Always use `mode: "json"` for any `generateObject` call targeting `deepSeekModel` (V3).

**Why:** The API returns "Thinking mode does not support this tool_choice" when `mode: "tool"` is passed to V3.

**How to apply:** Before any `generateObject` call using `deepSeekModel`, ensure `mode: "json"` not `mode: "tool"`.

## Route model assignments

| Route | Model | Reason |
|---|---|---|
| filter-signal, voice-dna | `deepSeekFlashModel` (v4-flash) | Fast simple extraction |
| write-section, write-chapter, content-map, polish, format, etc. | `deepSeekModel` (v4-pro) | Standard generation |
| architect (both passes), chapter-plan, audit, backmatter, frontmatter, ingest | `deepSeekReasonerModel` (deepseek-reasoner) | Deep reasoning |
