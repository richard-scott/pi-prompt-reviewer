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

## Features

- intercepts normal prompts before they are sent
- rewrites prompts for clarity while preserving intent
- can include recent conversation context when useful
- lets you choose the reviewer model and thinking level
- loads the reviewed prompt back into the editor automatically
- shows compact review details in a widget above the editor instead of a modal dialog
- lets you restore the original prompt with a command or shortcut
- displays token usage and cost for the review step
- retries once with a safe fallback if the reviewer returns no text

## Install

### From GitHub

```bash
pi install git:github.com/surfdude75/pi-prompt-reviewer
```

### From a local checkout

```bash
pi install /path/to/pi-prompt-reviewer
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
6. Press Enter to send the reviewed prompt, or restore the original first.

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

### Configure context mode

```text
/prompt-review context
/prompt-review context off
/prompt-review context smart
/prompt-review context always
```

Context modes:

- `off`: do not send recent conversation context
- `smart`: send the previous user prompt and last assistant reply only for
  referential follow-ups
- `always`: always send the previous user prompt and last assistant reply when
  they exist

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
- if review fails, choose another model with `/prompt-review model <model-pattern>`

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

## What the review widget shows

The widget shows:

- a compact metadata line with context, reviewer model, thinking level, token
  usage, and cost
- clarification questions when the reviewer has useful follow-up questions
- a reminder that Enter sends the reviewed prompt
- a reminder that `/prompt-review revert` or `Ctrl+Alt+R` restores the original

The widget is cleared automatically after the reviewed prompt is sent, after the
original prompt is restored, or when the review becomes stale because the editor
content changed.

## Bypasses

These inputs are not reviewed:

- slash commands such as `/help`
- `!` shortcuts
- prompts with image attachments

To skip review once for a normal prompt, prefix it with a backslash:

```text
\send this directly without review
```

## Retry behavior

If the first reviewer run returns no text, the extension retries once using the
current session model with thinking set to `off`.

## Development

For local development, a simple workflow is:

1. clone this repository
2. install it into pi from the local path
3. edit the files in this repository
4. run `/reload` in pi to pick up changes

Example:

```bash
pi install /home/rsilva/dev/pi-prompt-reviewer
```

Because local path installs are referenced directly from disk, pi reloads the
current repo contents. No copy step is needed.

## License

MIT
