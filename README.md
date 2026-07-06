# pi-prompt-reviewer

Clear prompts lead to better coding results, but typos, awkward wording, and
small misunderstandings can waste precious context, especially for people
writing in a second language. This extension puts a fast, lightweight reviewer
in front of your main pi session so weak prompts get cleaned up before they
create extra churn, making prompt review easy enough to become a habit and
helping you avoid the frustration of watching a long task fail because the
original request was unclear.

`pi-prompt-reviewer` is a [pi](https://pi.dev) extension that reviews your
prompt before it is sent to the main session.

![pi-prompt-reviewer preview](https://raw.githubusercontent.com/surfdude75/pi-prompt-reviewer/refs/heads/master/assets/preview.png)

## Features

- intercepts normal prompts before they are sent
- rewrites prompts for clarity while preserving intent
- can include recent conversation context when useful
- lets you choose the target language, reviewer model, and thinking level
- remembers the target language, reviewer model, and thinking level across sessions
- loads the reviewed prompt back into the editor automatically
- lets you submit immediately without review via `Ctrl+Shift+S` by default
- lets you restore the original prompt with a command or shortcut
- lets you remap or disable its shortcuts
- displays token usage and cost for the review step

## Install

```bash
pi install npm:pi-prompt-reviewer
```

After installing or editing the extension, reload pi:

```text
/reload
```

## How it works

1. Type a normal prompt.
2. Press Enter.
3. The extension reviews it with a lightweight model.
4. The reviewed prompt is loaded back into the editor.
5. A review widget appears above the editor.
6. Press Enter to send the reviewed prompt, restore the original first, or press
   Ctrl+Shift+S to submit the current editor contents without review.

## Bypasses

These inputs are not reviewed:

- slash commands such as `/help`
- `!` shortcuts
- prompts with image attachments

To skip review once for a normal prompt, prefix it with a backslash:

```text
\send this directly without review
```

To submit the current editor contents immediately without review, press the
configured shortcut. The default is:

```text
Ctrl+Shift+S
```

## Usage

### Enable or disable prompt review

```text
/prompt-review on
/prompt-review off
/prompt-review toggle
```

### Show status or help

```text
/prompt-review status
/prompt-review help
```

### Restore the original prompt after review

```text
/prompt-review revert
```

Default shortcut:

```text
Ctrl+Alt+R
```

### Configure shortcuts

Shortcuts are read from the same persistent preferences file used for reviewer
settings:

```text
~/.pi/agent/extensions/prompt-reviewer.json
```

Example:

```json
{
  "shortcuts": {
    "submitWithoutReview": "ctrl+shift+f",
    "revert": "ctrl+alt+r"
  }
}
```

Set either shortcut to `false` to disable it:

```json
{
  "shortcuts": {
    "submitWithoutReview": false,
    "revert": false
  }
}
```

After editing the file, reload pi:

```text
/reload
```

### Configure context mode

```text
/prompt-review context
/prompt-review context off
/prompt-review context always
```

Context modes:

- `off`: do not send recent conversation context
- `always`: always send the previous user prompt and last assistant reply when
  they exist

### Configure target language

```text
/prompt-review language
/prompt-review language match input
/prompt-review language English
/prompt-review language Brazilian Portuguese
```

The default is `match input`, which keeps the reviewed prompt in the same
language as your input prompt. Set a specific language to have the reviewer
translate the reviewed prompt as needed.

### Configure reviewer model

```text
/prompt-review model
/prompt-review model auto
/prompt-review model <model-pattern>
```

Examples:

```text
/prompt-review model openai-codex/gpt-5.4-mini
/prompt-review model haiku
```

Notes:

- `auto` prefers a lightweight available model
- the default auto-selected model may not be supported by your subscription
- explicit reviewer model changes are tested before they are saved
- if the test fails, the extension warns you and keeps the previous reviewer model

### Configure reviewer thinking

```text
/prompt-review thinking
/prompt-review thinking off
/prompt-review thinking minimal
/prompt-review thinking low
/prompt-review thinking medium
/prompt-review thinking high
/prompt-review thinking xhigh
```

Recommended default:

- model: `auto`
- thinking: `off`

This is usually the best balance of speed, cost, and review quality.

Thinking changes are also tested before they are saved. If the test fails, the
extension warns you and keeps the previous reviewer thinking level.

Target language, reviewer model, reviewer thinking, and shortcut choices are
saved across sessions. The enabled/disabled state and context mode remain
session-specific.

## Retry behavior

If the first reviewer run returns no text, the extension retries once using the
current session model with thinking set to `off`.
