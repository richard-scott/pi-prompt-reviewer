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
- lets you choose the target language, English dialect, reviewer model, thinking level, auto-submit mode, and processing indicator behaviour
- remembers the target language, English dialect, processing text/status, reviewer model, thinking level, and auto-submit mode across sessions
- loads the reviewed prompt back into the editor automatically
- can automatically submit ready/revised reviewed prompts
- preserves English dialect, including deterministic British spelling normalisation when configured or detected
- shows configurable processing text with a toggleable loading indicator while review runs
- lets you submit immediately without review via `Ctrl+Shift+S`
- lets you restore the original prompt with a command or shortcut
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
3. If processing status is enabled, a loading indicator shows the configured processing text, defaulting to `Processing...`, while the reviewer runs.
4. The extension reviews it with a lightweight model.
5. By default, the reviewed prompt is loaded back into the editor.
6. A review widget appears above the editor.
7. Press Enter to send the reviewed prompt, restore the original first, or press
   Ctrl+Shift+S to submit the current editor contents without review.

When auto-submit is enabled, ready/revised reviewed prompts are sent to the main
session immediately instead of being loaded for manual approval. Auto-submit is
skipped when the reviewer says the prompt needs clarification.

## Bypasses

These inputs are not reviewed:

- slash commands such as `/help`
- `!` shortcuts
- prompts with image attachments

To skip review once for a normal prompt, prefix it with a backslash:

```text
\send this directly without review
```

To submit the current editor contents immediately without review, press:

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

Status includes the current context mode, target language, English dialect,
processing text, processing status visibility, reviewer model, thinking level,
and auto-submit setting.

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
/prompt-review context always
```

Context modes:

- `off`: do not send recent conversation context
- `always`: always send the previous user prompt and last assistant reply when
  they exist

### Configure auto-submit

```text
/prompt-review autosubmit
/prompt-review autosubmit on
/prompt-review autosubmit off
```

Auto-submit is off by default. When it is on, reviewed prompts whose decision is
`ready` or `revised` are sent immediately. If the reviewer returns
`needs_clarification`, the reviewed prompt is loaded into the editor for manual
approval instead.

### Configure processing text and status visibility

```text
/prompt-review processing
/prompt-review processing Processing
/prompt-review processing Reviewing prompt
/prompt-review processing-status
/prompt-review processing-status on
/prompt-review processing-status off
```

The processing text is shown with a loading indicator while prompt review runs.
It defaults to `Processing`, displayed as `Processing...`. Toggle the indicator
and working message with `processing-status on|off`. When processing status is
off, the reviewer still runs normally, but the in-progress loading indicator and
working message are hidden. These values are saved in
`~/.pi/agent/extensions/prompt-reviewer.json` as `processingText` and
`showProcessingStatus`, so you can edit that config file directly if preferred.

### Configure English dialect

```text
/prompt-review dialect
/prompt-review dialect auto
/prompt-review dialect british
/prompt-review dialect us
/prompt-review dialect preserve
```

Dialect modes:

- `auto`: infer from target language, locale, and time zone
- `british`: force British English with -ise spellings and instruct the reviewer to
  normalise words with standard British `-ise` forms, such as `finalize` →
  `finalise`, `theorize` → `theorise`, and `tantalize` → `tantalise`
- `us`: instruct the reviewer to use US English
- `preserve`: preserve the prompt's existing dialect

### Configure target language

```text
/prompt-review language
/prompt-review language match input
/prompt-review language English
/prompt-review language UK English
/prompt-review language Brazilian Portuguese
```

The default is `match input`. Set a specific language to have the reviewer
translate the reviewed prompt as needed. In `auto` mode, `UK English` and
`British English` force British -ise spellings such as `finalise`,
`analyse`, and `colour`.

Built-in target language completions:

- `match input`
- `English`
- `UK English`
- `British English`
- `US English`
- `American English`
- `Spanish`
- `French`
- `German`
- `Italian`
- `Portuguese`
- `Brazilian Portuguese`
- `Japanese`
- `Korean`
- `Chinese`
- `Dutch`
- `Polish`
- `Russian`
- `Ukrainian`
- `Arabic`
- `Hindi`

You can also type a custom target language; known entries are mainly for
completion and normalisation.

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

Target language, English dialect, processing text/status, reviewer model,
reviewer thinking, and auto-submit choices are saved across sessions in
`~/.pi/agent/extensions/prompt-reviewer.json`. The enabled/disabled state and
context mode remain session-specific.

Example preferences file:

```json
{
  "targetLanguage": "UK English",
  "reviewerModel": "auto",
  "reviewerThinking": "off",
  "autoSubmit": true,
  "englishDialect": "british",
  "processingText": "Processing",
  "showProcessingStatus": true
}
```

## Retry behaviour

If the first reviewer run returns no text, the extension retries once using the
current session model with thinking set to `off`.
