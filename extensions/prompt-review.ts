import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, Key, wrapTextWithAnsi, type AutocompleteItem } from "@mariozechner/pi-tui";

type ReviewContextMode = "off" | "always";
type ReviewerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type EnglishDialectMode = "auto" | "british" | "us" | "preserve";

type ReviewState = {
  enabled: boolean;
  contextMode: ReviewContextMode;
  targetLanguage: string;
  reviewerModel?: string;
  reviewerThinking: ReviewerThinkingLevel;
  autoSubmit: boolean;
  englishDialect: EnglishDialectMode;
  processingText: string;
  showProcessingStatus: boolean;
};

type ReviewPreferences = Pick<ReviewState, "targetLanguage" | "reviewerModel" | "reviewerThinking" | "autoSubmit" | "englishDialect" | "processingText" | "showProcessingStatus">;

type LoadedReviewPreferences = {
  preferences: ReviewPreferences;
  source: "file" | "missing" | "invalid";
};

type PendingReview = {
  originalText: string;
  contextLabel: string;
  targetLanguage: string;
  reviewerModelLabel: string;
  reviewerThinking: ReviewerThinkingLevel;
  englishDialect: EnglishDialectMode;
  reviewContext?: ReviewContext;
  retryCount: number;
};

type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type ReviewRunResult = {
  resultText: string;
  tokens: TokenUsage;
  cost: number;
};

type ParsedReview = {
  decision: "ready" | "revised" | "needs_clarification" | "unknown";
  questions: string[];
  prompt: string;
};

type ContextBlock = {
  text: string;
  truncated: boolean;
};

type ReviewContext = {
  previousUserPrompt?: ContextBlock;
  assistantReply?: ContextBlock;
};

type ActiveReview = {
  originalText: string;
  reviewedText: string;
};

const ROOT_COMMAND_OPTIONS = ["on", "off", "toggle", "status", "help", "context", "autosubmit", "dialect", "processing", "processing-status", "language", "model", "thinking", "revert"] as const;
const CONTEXT_MODE_OPTIONS = ["off", "always"] as const;
const AUTOSUBMIT_OPTIONS = ["on", "off"] as const;
const PROCESSING_STATUS_OPTIONS = ["on", "off"] as const;
const ENGLISH_DIALECT_OPTIONS = ["auto", "british", "us", "preserve"] as const;
const THINKING_LEVEL_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_CONTEXT_MODE: ReviewContextMode = "always";
const DEFAULT_TARGET_LANGUAGE = "match input";
const DEFAULT_REVIEWER_THINKING: ReviewerThinkingLevel = "off";
const DEFAULT_ENGLISH_DIALECT: EnglishDialectMode = "auto";
const DEFAULT_PROCESSING_TEXT = "Processing";
const TARGET_LANGUAGE_OPTIONS = [
  DEFAULT_TARGET_LANGUAGE,
  "English",
  "UK English",
  "British English",
  "US English",
  "American English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Brazilian Portuguese",
  "Japanese",
  "Korean",
  "Chinese",
  "Dutch",
  "Polish",
  "Russian",
  "Ukrainian",
  "Arabic",
  "Hindi",
] as const;
const TARGET_LANGUAGE_MATCH_INPUT_ALIASES = new Set(["match input", "match-input", "match", "input", "auto"]);
const REVIEW_STATE_ENTRY = "prompt-review:state";
const REVIEW_PREFERENCES_FILE = "prompt-reviewer.json";
const REVIEW_WIDGET_KEY = "prompt-review";
const REVERT_SHORTCUT_LABEL = "Ctrl+Alt+R";
const SUBMIT_WITHOUT_REVIEW_SHORTCUT_LABEL = "Ctrl+Shift+S";
const REVIEW_CONFIG_TEST_PROMPT = "Reply with exactly OK and nothing else.";
const REVIEW_INDICATOR_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const MAX_CONTEXT_CHARS = 4_000;
const AUTO_REVIEWER_MODEL_CANDIDATES = [
  "haiku",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gemini-2.5-flash",
  "gemini-flash",
  "flash",
  "mini",
  "nano",
] as const;
const AUTO_REVIEWER_MODEL_CANDIDATES_BY_PROVIDER: Record<string, readonly string[]> = {
  anthropic: ["haiku"],
  openai: ["gpt-5.4-mini", "gpt-5-mini", "gpt-5-nano", "gpt-4.1-mini"],
  "openai-codex": ["gpt-5.4-mini", "gpt-5-mini", "gpt-5-nano", "gpt-4.1-mini"],
  google: ["gemini-2.5-flash", "gemini-flash", "flash"],
};
let completionCtx: ExtensionContext | undefined;

function splitArgs(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProcessingText(value: string | undefined): string {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");
  return normalized || DEFAULT_PROCESSING_TEXT;
}

function formatProcessingText(value: string): string {
  return `${normalizeProcessingText(value).replace(/[.。…]+$/g, "")}...`;
}

function isContextMode(value: string): value is ReviewContextMode {
  return CONTEXT_MODE_OPTIONS.includes(value as ReviewContextMode);
}

function isThinkingLevel(value: string): value is ReviewerThinkingLevel {
  return THINKING_LEVEL_OPTIONS.includes(value as ReviewerThinkingLevel);
}

function isEnglishDialectMode(value: string): value is EnglishDialectMode {
  return ENGLISH_DIALECT_OPTIONS.includes(value as EnglishDialectMode);
}

function normalizeTargetLanguage(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return DEFAULT_TARGET_LANGUAGE;
  if (TARGET_LANGUAGE_MATCH_INPUT_ALIASES.has(normalized.toLowerCase())) return DEFAULT_TARGET_LANGUAGE;

  const knownLanguage = TARGET_LANGUAGE_OPTIONS.find(
    (language) => language.toLowerCase() === normalized.toLowerCase(),
  );
  return knownLanguage ?? normalized;
}

function isMatchInputTargetLanguage(targetLanguage: string): boolean {
  return normalizeTargetLanguage(targetLanguage) === DEFAULT_TARGET_LANGUAGE;
}

function detectLocalEnglishDialect(): string {
  const explicitLocaleCandidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\.UTF-?8$/i, "").replace(/_/g, "-"))
    .filter((value) => !/^(C|POSIX)$/i.test(value));

  const britishEnglishRegions = new Set(["GB", "IE", "AU", "NZ", "ZA"]);
  const americanEnglishRegions = new Set(["US", "PH"]);

  const classifyLocale = (locale: string): string | undefined => {
    const match = locale.match(/^en-([A-Za-z]{2})\b/i);
    const region = match?.[1]?.toUpperCase();
    if (!region) return undefined;
    if (britishEnglishRegions.has(region)) return "British English";
    if (americanEnglishRegions.has(region)) return "US English";
    return undefined;
  };

  for (const locale of explicitLocaleCandidates) {
    const dialect = classifyLocale(locale);
    if (dialect) return dialect;
  }

  const timeZoneCandidates = [
    process.env.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ].filter((value): value is string => Boolean(value));

  if (timeZoneCandidates.some((timeZone) => /^(Europe\/London|Europe\/Dublin)$/i.test(timeZone))) {
    return "British English";
  }
  if (timeZoneCandidates.some((timeZone) => /^(Australia\/|Pacific\/Auckland|Pacific\/Chatham|Africa\/Johannesburg)/i.test(timeZone))) {
    return "British English";
  }

  const runtimeLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const runtimeDialect = runtimeLocale ? classifyLocale(runtimeLocale.replace(/_/g, "-")) : undefined;
  if (runtimeDialect) return runtimeDialect;

  return "unknown; infer from the input prompt and reference context";
}

function shouldUseBritishEnglish(targetLanguage: string, englishDialect: EnglishDialectMode): boolean {
  if (englishDialect === "british") return true;
  if (englishDialect === "us" || englishDialect === "preserve") return false;

  const normalizedTarget = normalizeTargetLanguage(targetLanguage).toLowerCase();
  if (/(^|\b)(uk|british|commonwealth)(\b|$)/i.test(normalizedTarget)) return true;
  if (normalizedTarget === DEFAULT_TARGET_LANGUAGE.toLowerCase()) {
    return detectLocalEnglishDialect() === "British English";
  }
  return false;
}


const BRITISH_TO_US_REPLACEMENTS = new Map<string, string>([
  ["finaize", "finalize"],
  ["finaized", "finalized"],
  ["finaizing", "finalizing"],
  ["finalise", "finalize"],
  ["finalised", "finalized"],
  ["finalising", "finalizing"],
  ["finalisation", "finalization"],
  ["organise", "organize"],
  ["organised", "organized"],
  ["organising", "organizing"],
  ["organisation", "organization"],
  ["organisations", "organizations"],
  ["recognise", "recognize"],
  ["recognised", "recognized"],
  ["recognising", "recognizing"],
  ["recognition", "recognition"],
  ["realise", "realize"],
  ["realised", "realized"],
  ["realising", "realizing"],
  ["authorise", "authorize"],
  ["authorised", "authorized"],
  ["authorising", "authorizing"],
  ["customise", "customize"],
  ["customised", "customized"],
  ["customising", "customizing"],
  ["optimise", "optimize"],
  ["optimised", "optimized"],
  ["optimising", "optimizing"],
  ["prioritise", "prioritize"],
  ["prioritised", "prioritized"],
  ["prioritising", "prioritizing"],
  ["initialise", "initialize"],
  ["initialised", "initialized"],
  ["initialising", "initializing"],
  ["normalise", "normalize"],
  ["normalised", "normalized"],
  ["normalising", "normalizing"],
  ["serialise", "serialize"],
  ["serialised", "serialized"],
  ["serialising", "serializing"],
  ["specialise", "specialize"],
  ["specialised", "specialized"],
  ["specialising", "specializing"],
  ["summarise", "summarize"],
  ["summarised", "summarized"],
  ["summarising", "summarizing"],
  ["categorise", "categorize"],
  ["categorised", "categorized"],
  ["categorising", "categorizing"],
  ["visualise", "visualize"],
  ["visualised", "visualized"],
  ["visualising", "visualizing"],
  ["utilise", "utilize"],
  ["utilised", "utilized"],
  ["utilising", "utilizing"],
  ["standardise", "standardize"],
  ["standardised", "standardized"],
  ["standardising", "standardizing"],
  ["modernise", "modernize"],
  ["modernised", "modernized"],
  ["modernising", "modernizing"],
]);

function matchCase(source: string, replacement: string): string {
  if (source.toUpperCase() === source) return replacement.toUpperCase();
  if (source[0]?.toUpperCase() === source[0]) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const BRITISH_REPLACEMENTS = new Map<string, string>([
  ["finaize", "finalise"],
  ...[...BRITISH_TO_US_REPLACEMENTS]
    .filter(([source, replacement]) => source !== replacement && !source.startsWith("finaiz"))
    .map(([source, replacement]) => [replacement, source] as [string, string]),
]);

function applyWordReplacements(text: string, replacements: Map<string, string>): string {
  return text.replace(/\b[A-Za-z]+\b/g, (word) => {
    const replacement = replacements.get(word.toLowerCase());
    return replacement ? matchCase(word, replacement) : word;
  });
}

function applyBritishEnglish(text: string): string {
  return applyWordReplacements(text, BRITISH_REPLACEMENTS);
}

function getTargetLanguageCompletions(languagePrefix: string): AutocompleteItem[] | null {
  const prefix = languagePrefix.trim();
  const filtered = prefix
    ? fuzzyFilter([...TARGET_LANGUAGE_OPTIONS], prefix, (language) => language)
    : [...TARGET_LANGUAGE_OPTIONS];

  if (filtered.length === 0) return null;

  return filtered.map((language) => ({
    value: `language ${language}`,
    label: `language ${language}`,
  }));
}

async function getCommandCompletions(prefix: string): Promise<AutocompleteItem[] | null> {
  const trimmed = prefix.replace(/^\s+/, "");
  const hasTrailingSpace = /\s$/.test(trimmed);
  const tokens = splitArgs(trimmed);

  if (tokens.length === 0) {
    return ROOT_COMMAND_OPTIONS.map((value) => ({ value, label: value }));
  }

  if (tokens.length === 1 && !hasTrailingSpace) {
    const values = ROOT_COMMAND_OPTIONS.filter((value) => value.startsWith(tokens[0]!));
    if (values.length === 0) return null;
    return values.map((value) => ({ value, label: value }));
  }

  if (tokens[0] === "language") {
    return getTargetLanguageCompletions(hasTrailingSpace ? "" : tokens.slice(1).join(" "));
  }

  if (tokens.length > 2) return null;

  if (tokens[0] === "context") {
    const modePrefix = hasTrailingSpace ? "" : (tokens[1] ?? "");
    const values = CONTEXT_MODE_OPTIONS
      .filter((value) => value.startsWith(modePrefix))
      .map((value) => ({ value: `context ${value}`, label: `context ${value}` }));
    return values.length > 0 ? values : null;
  }

  if (tokens[0] === "dialect") {
    const dialectPrefix = hasTrailingSpace ? "" : (tokens[1] ?? "");
    const values = ENGLISH_DIALECT_OPTIONS
      .filter((value) => value.startsWith(dialectPrefix))
      .map((value) => ({ value: `dialect ${value}`, label: `dialect ${value}` }));
    return values.length > 0 ? values : null;
  }

  if (tokens[0] === "autosubmit") {
    const autoSubmitPrefix = hasTrailingSpace ? "" : (tokens[1] ?? "");
    const values = AUTOSUBMIT_OPTIONS
      .filter((value) => value.startsWith(autoSubmitPrefix))
      .map((value) => ({ value: `autosubmit ${value}`, label: `autosubmit ${value}` }));
    return values.length > 0 ? values : null;
  }

  if (tokens[0] === "processing-status") {
    const statusPrefix = hasTrailingSpace ? "" : (tokens[1] ?? "");
    const values = PROCESSING_STATUS_OPTIONS
      .filter((value) => value.startsWith(statusPrefix))
      .map((value) => ({ value: `processing-status ${value}`, label: `processing-status ${value}` }));
    return values.length > 0 ? values : null;
  }

  if (tokens[0] === "thinking") {
    const levelPrefix = hasTrailingSpace ? "" : (tokens[1] ?? "");
    const values = THINKING_LEVEL_OPTIONS
      .filter((value) => value.startsWith(levelPrefix))
      .map((value) => ({ value: `thinking ${value}`, label: `thinking ${value}` }));
    return values.length > 0 ? values : null;
  }

  if (tokens[0] === "model") {
    return await getModelCommandCompletions(hasTrailingSpace ? "" : (tokens[1] ?? ""));
  }

  return null;
}

function buildHelpText(
  enabled: boolean,
  contextMode: ReviewContextMode,
  targetLanguage: string,
  reviewerModel: string | undefined,
  reviewerThinking: ReviewerThinkingLevel,
  autoSubmit: boolean,
  englishDialect: EnglishDialectMode,
  processingText: string,
  showProcessingStatus: boolean,
): string {
  return [
    "Usage:",
    "  /prompt-review on",
    "  /prompt-review off",
    "  /prompt-review toggle",
    "  /prompt-review status",
    "  /prompt-review context",
    "  /prompt-review context off|always",
    "  /prompt-review autosubmit",
    "  /prompt-review autosubmit on|off",
    "  /prompt-review dialect",
    "  /prompt-review dialect auto|british|us|preserve",
    "  /prompt-review processing",
    "  /prompt-review processing <text>",
    "  /prompt-review processing-status on|off",
    "  /prompt-review language",
    "  /prompt-review language match input|<language>",
    "  /prompt-review model",
    "  /prompt-review model auto",
    "  /prompt-review model <model-pattern>",
    "  /prompt-review thinking",
    "  /prompt-review thinking off|minimal|low|medium|high|xhigh",
    "  /prompt-review revert",
    "",
    `Current mode: ${enabled ? "enabled" : "disabled"}`,
    `Current context mode: ${contextMode}`,
    `Current target language: ${targetLanguage}`,
    `Current reviewer model: ${reviewerModel ?? "auto"}`,
    `Current reviewer thinking: ${reviewerThinking}`,
    `Current auto-submit: ${autoSubmit ? "on" : "off"}`,
    `Current English dialect: ${englishDialect}`,
    `Current processing text: ${normalizeProcessingText(processingText)}`,
    `Current processing status: ${showProcessingStatus ? "on" : "off"}`,
    "",
    "When enabled:",
    "- normal prompts are intercepted before they reach the main session",
    "- a lightweight review session reviews and rewrites the prompt",
    "- the reviewed prompt is loaded back into the editor",
    "- when auto-submit is on, ready/revised reviewed prompts are sent immediately instead",
    "- review details are shown above the editor when the reviewed prompt is not auto-submitted",
    `- press Enter to send the reviewed prompt, or use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original`,
    `- press ${SUBMIT_WITHOUT_REVIEW_SHORTCUT_LABEL} to submit the current editor contents without review`,
    "",
    "Context modes:",
    "- off: do not send recent conversation context",
    "- always: always send the previous user prompt and last assistant reply when they exist",
    "",
    "Auto-submit:",
    "- autosubmit off: load the reviewed prompt back into the editor for approval",
    "- autosubmit on: automatically send ready/revised reviewed prompts",
    "- auto-submit is skipped when the reviewer says the prompt needs clarification",
    "",
    "English dialect:",
    "- dialect auto: infer from target language, locale, and time zone",
    "- dialect british: force British English with -ise spellings and normalise common -ize forms to -ise",
    "- dialect us: force US English instructions",
    "- dialect preserve: preserve the prompt's existing dialect",
    "",
    "Processing text:",
    "- processing: show the configured review-in-progress text",
    "- processing <text>: save the text shown with the loading indicator while review runs",
    "- processing-status on|off: show or hide the review-in-progress indicator and working message",
    "- stored in ~/.pi/agent/extensions/prompt-reviewer.json as processingText and showProcessingStatus",
    "",
    "Target language:",
    "- language match input: write the reviewed prompt in the input prompt's language",
    "- language <language>: write the reviewed prompt in that language, translating as needed",
    "",
    "Reviewer model selection:",
    "- model auto: prefer a lightweight available model (for example haiku, gpt-5.4-mini, mini, nano, or flash)",
    "- model <model-pattern>: choose any available model by fuzzy name or provider/id",
    "- explicit reviewer model changes are tested before they are saved",
    "- note: the default auto-selected model may not be supported by your subscription; if review fails, pick another model with /prompt-review model <model-pattern>",
    "",
    "Reviewer thinking selection:",
    "- off is the fastest and cheapest default",
    "- higher levels may improve edge-case rewrites but cost more and can be slower",
    "- thinking changes are tested before they are saved",
    "",
    "Persistent preferences:",
    "- target language, English dialect, processing text/status, reviewer model, reviewer thinking, and auto-submit are saved across sessions",
    "- enabled/disabled and context mode remain session-specific settings",
    "",
    "Bypasses:",
    "- slash commands and !bash shortcuts are not reviewed",
    "- prompts with image attachments are sent directly",
    "- prefix a prompt with \\ to skip review once",
    `- press ${SUBMIT_WITHOUT_REVIEW_SHORTCUT_LABEL} to submit the current editor contents without review`,
    "",
    "Tip:",
    "- edit .pi/extensions/prompt-review.ts to change the reviewer behaviour",
  ].join("\n");
}

function buildStatusText(
  enabled: boolean,
  contextMode: ReviewContextMode,
  targetLanguage: string,
  reviewerModel: string | undefined,
  reviewerThinking: ReviewerThinkingLevel,
  autoSubmit: boolean,
  englishDialect: EnglishDialectMode,
  processingText: string,
  showProcessingStatus: boolean,
): string {
  return `prompt review: ${enabled ? "enabled" : "disabled"} (context: ${contextMode}, language: ${targetLanguage}, dialect: ${englishDialect}, processing: ${normalizeProcessingText(processingText)}, processingStatus: ${showProcessingStatus ? "on" : "off"}, model: ${reviewerModel ?? "auto"}, thinking: ${reviewerThinking}, autosubmit: ${autoSubmit ? "on" : "off"})`;
}

function buildContextModeText(contextMode: ReviewContextMode): string {
  return `prompt review context: ${contextMode}`;
}

function buildTargetLanguageText(targetLanguage: string): string {
  return `prompt review target language: ${targetLanguage}`;
}

function buildModelText(reviewerModel: string | undefined): string {
  return `prompt review model: ${reviewerModel ?? "auto"}`;
}

function buildThinkingText(reviewerThinking: ReviewerThinkingLevel): string {
  return `prompt review thinking: ${reviewerThinking}`;
}

function buildAutoSubmitText(autoSubmit: boolean): string {
  return `prompt review autosubmit: ${autoSubmit ? "on" : "off"}`;
}

function buildDialectText(englishDialect: EnglishDialectMode): string {
  return `prompt review English dialect: ${englishDialect}`;
}

function buildProcessingText(processingText: string): string {
  return `prompt review processing text: ${normalizeProcessingText(processingText)}`;
}

function buildProcessingStatusText(showProcessingStatus: boolean): string {
  return `prompt review processing status: ${showProcessingStatus ? "on" : "off"}`;
}

function buildReviewPrompt(
  prompt: string,
  targetLanguage: string,
  englishDialect: EnglishDialectMode,
  context?: ReviewContext,
): string {
  const hasContext = Boolean(context?.previousUserPrompt || context?.assistantReply);
  const isMatchInputLanguage = isMatchInputTargetLanguage(targetLanguage);
  const localEnglishDialect = detectLocalEnglishDialect();
  const useBritishEnglish = shouldUseBritishEnglish(targetLanguage, englishDialect);
  const languageRule = isMatchInputLanguage
    ? "- TARGET_LANGUAGE is match input: write FINAL_PROMPT content and any clarification question text in the same language as CURRENT_USER_PROMPT_TO_REVIEW. If the input mixes languages, use the primary input language."
    : `- TARGET_LANGUAGE is ${targetLanguage}: you MUST translate FINAL_PROMPT content and any clarification question text into ${targetLanguage}. Do not leave FINAL_PROMPT in the source language unless the source language is already ${targetLanguage}.`;

  return [
    "Review the following user prompt before it is sent to the main pi session.",
    "Follow the system prompt and return only the required review format.",
    "",
    "TARGET_LANGUAGE:",
    targetLanguage,
    "ENGLISH_DIALECT_SETTING:",
    englishDialect,
    "DETECTED_LOCAL_ENGLISH_DIALECT:",
    localEnglishDialect,
    "BRITISH_ENGLISH_REQUIRED:",
    useBritishEnglish ? "yes" : "no",
    isMatchInputLanguage
      ? "The final prompt should match the input language."
      : `The final prompt must be written in ${targetLanguage}, translating the user's request as needed while preserving intent.`,
    "Treat TARGET_LANGUAGE as a hard requirement, not a suggestion.",
    "",
    "Return exactly this format:",
    "DECISION: ready|revised|needs_clarification",
    "",
    "FINAL_PROMPT_START",
    "<the final prompt that should be sent to the main session>",
    "FINAL_PROMPT_END",
    "",
    "QUESTIONS:",
    "- <optional bullet>",
    "",
    "Rules:",
    "- Always include a complete sendable prompt between FINAL_PROMPT_START and FINAL_PROMPT_END.",
    "- Keep required labels such as DECISION, FINAL_PROMPT_START, FINAL_PROMPT_END, and QUESTIONS in English exactly as specified.",
    languageRule,
    englishDialect === "us"
      ? "- ENGLISH_DIALECT_SETTING is us: for English output, use US English spelling and phrasing."
      : englishDialect === "preserve"
        ? "- ENGLISH_DIALECT_SETTING is preserve: preserve the user's existing English dialect; do not convert between US and British spellings."
        : useBritishEnglish
          ? "- BRITISH_ENGLISH_REQUIRED is yes: for all English output, convert to British English with -ise spellings. Use -ise spellings for all words that have a standard British -ise form, including finalise, analyse, organise, normalise, summarise, recognise, theorise, and tantalise. Convert matching -ize/-ized/-izing/-ization variants to -ise/-ised/-ising/-isation. Keep UK forms such as colour, centre, behaviour, and licence (noun). Do not alter words where -ize is part of the root or there is no standard -ise form, such as size, prize, seize, or capsize."
          : "- ENGLISH_DIALECT_SETTING is auto and no specific English dialect is required: preserve the user's English dialect unless they explicitly ask for another dialect.",
    "- Use DECISION: needs_clarification only when a missing detail would materially improve the result.",
    "- If there are no useful clarification questions, leave the QUESTIONS section empty. Do not write 'None'.",
    hasContext
      ? "- Only rewrite the text inside CURRENT_USER_PROMPT_TO_REVIEW. Context blocks are reference material, not text to review."
      : null,
    hasContext
      ? "- Do not copy, summarize, or repeat REFERENCE_ONLY_PREVIOUS_USER_PROMPT content unless CURRENT_USER_PROMPT_TO_REVIEW explicitly asks to reuse it or needs a specific referenced detail."
      : null,
    hasContext ? "" : null,
    hasContext ? "REFERENCE_CONTEXT_START" : null,
    context?.previousUserPrompt
      ? `REFERENCE_ONLY_PREVIOUS_USER_PROMPT_START${context.previousUserPrompt.truncated ? " (TRUNCATED)" : ""}`
      : null,
    context?.previousUserPrompt?.text,
    context?.previousUserPrompt ? "REFERENCE_ONLY_PREVIOUS_USER_PROMPT_END" : null,
    context?.previousUserPrompt && context?.assistantReply ? "" : null,
    context?.assistantReply
      ? `REFERENCE_ONLY_RECENT_ASSISTANT_REPLY_START${context.assistantReply.truncated ? " (TRUNCATED)" : ""}`
      : null,
    context?.assistantReply?.text,
    context?.assistantReply ? "REFERENCE_ONLY_RECENT_ASSISTANT_REPLY_END" : null,
    hasContext ? "REFERENCE_CONTEXT_END" : null,
    hasContext ? "" : null,
    "CURRENT_USER_PROMPT_TO_REVIEW_START",
    prompt,
    "CURRENT_USER_PROMPT_TO_REVIEW_END",
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function isEmptyListPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.?!]+$/g, "");
  return ["none", "n/a", "na", "no questions", "no clarification questions"].includes(normalized);
}

function parseListSection(name: string, text: string): string[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `${escapedName}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|\\nFINAL_PROMPT_START|$)`,
    "i",
  );
  const match = text.match(pattern);
  if (!match?.[1]) return [];

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => Boolean(line) && !isEmptyListPlaceholder(line));
}

function parseReview(text: string): ParsedReview {
  const decisionMatch = text.match(/^DECISION:\s*(.+)$/im);
  const promptMatch = text.match(/FINAL_PROMPT_START\s*([\s\S]*?)\s*FINAL_PROMPT_END/i);

  const decisionRaw = decisionMatch?.[1]?.trim().toLowerCase() ?? "unknown";
  const decision =
    decisionRaw === "ready" || decisionRaw === "revised" || decisionRaw === "needs_clarification"
      ? decisionRaw
      : "unknown";

  return {
    decision,
    questions: parseListSection("QUESTIONS", text),
    prompt: promptMatch?.[1]?.trim() ?? "",
  };
}

function formatTokenUsage(tokens: TokenUsage | undefined): string | undefined {
  if (!tokens) return undefined;
  const parts = [
    `${tokens.input.toLocaleString()} in`,
    `${tokens.output.toLocaleString()} out`,
  ];
  if (tokens.cacheRead > 0) parts.push(`${tokens.cacheRead.toLocaleString()} cache read`);
  if (tokens.cacheWrite > 0) parts.push(`${tokens.cacheWrite.toLocaleString()} cache write`);
  parts.push(`${tokens.total.toLocaleString()} total`);
  return `Usage: ${parts.join(" · ")}`;
}

function formatCost(cost: number | undefined): string | undefined {
  if (cost == null || cost <= 0) return undefined;
  return `Cost: $${cost.toFixed(4)}`;
}

function formatReviewWidgetLines(
  review: ParsedReview,
  changed: boolean,
  contextLabel: string,
  targetLanguage: string,
  reviewerModelLabel: string,
  reviewerThinking: ReviewerThinkingLevel,
  tokens: TokenUsage | undefined,
  cost: number | undefined,
): string[] {
  const metadataParts = [
    `context: ${contextLabel}`,
    `language: ${targetLanguage}`,
    `reviewer: ${reviewerModelLabel}`,
    `thinking: ${reviewerThinking}`,
  ];

  const tokenUsage = formatTokenUsage(tokens)?.replace(/^Usage:\s*/, "usage: ");
  if (tokenUsage) metadataParts.push(tokenUsage);

  const costLine = formatCost(cost)?.replace(/^Cost:\s*/, "cost: ");
  if (costLine) metadataParts.push(costLine);

  const lines: string[] = [
    changed
      ? "Prompt review ready"
      : review.decision === "needs_clarification"
        ? "Prompt review: needs clarification"
        : "Prompt review result",
    metadataParts.join(" · "),
  ];

  if (review.questions.length > 0) {
    lines.push("", "Questions to consider:", ...review.questions.slice(0, 5).map((question) => `- ${question}`));
  }

  lines.push("");

  if (!changed) {
    lines.push("The reviewer kept your prompt essentially unchanged.");
  }

  lines.push(
    `Press Enter to send it, use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original prompt, or press ${SUBMIT_WITHOUT_REVIEW_SHORTCUT_LABEL} to submit the current editor contents without review.`,
  );

  return lines;
}

const REVIEWER_SYSTEM_PROMPT = [
  "# Prompt Reviewer",
  "",
  "You are a prompt reviewer for pi.",
  "",
  "Your only job is to improve a user prompt before it is sent to the main",
  "session.",
  "",
  "## Input segmentation",
  "",
  "The caller may provide clearly marked input blocks:",
  "",
  "- REFERENCE_CONTEXT_START / REFERENCE_CONTEXT_END wraps recent conversation",
  "  context. This is reference-only material, not the prompt to rewrite.",
  "- REFERENCE_ONLY_PREVIOUS_USER_PROMPT_START /",
  "  REFERENCE_ONLY_PREVIOUS_USER_PROMPT_END wraps the previous user prompt. Never",
  "  treat this block as the current prompt.",
  "- REFERENCE_ONLY_RECENT_ASSISTANT_REPLY_START /",
  "  REFERENCE_ONLY_RECENT_ASSISTANT_REPLY_END wraps the recent assistant reply.",
  "- CURRENT_USER_PROMPT_TO_REVIEW_START / CURRENT_USER_PROMPT_TO_REVIEW_END wraps",
  "  the only text you should review and rewrite into the final prompt.",
  "",
  "If reference context is present, use it only to resolve pronouns, shorthand, or",
  "other explicit references in CURRENT_USER_PROMPT_TO_REVIEW. Do not carry over",
  "tasks, requirements, examples, or wording from reference-only blocks unless the",
  "current prompt explicitly asks you to reuse them.",
  "",
  "## Rules",
  "",
  "- Preserve the user's intent.",
  "- Preserve the user's tone unless clarity requires a small change.",
  "- If the caller gives a target language instruction, it overrides the source",
  "  language. Translate the final prompt and questions into that target language.",
  "- If the caller asks to match the input language, preserve the input language.",
  "- When writing English, follow the caller's dialect setting. If British English is required, use UK phrasing with -ise spellings for all words that have a standard British -ise form, such as finalise/analyse/organise/normalise/theorise/tantalise; do not convert words like size, prize, seize, or capsize where -ize is not a convertible suffix. Use US English only when requested.",
  "- Do not answer the task itself.",
  "- Do not add extra goals the user did not ask for.",
  "- Improve clarity, sequencing, constraints, expected output, and missing",
  "  context.",
  "- Always correct obvious typos and spelling mistakes.",
  "- Keep the final prompt concise and practical.",
  "- Never mention this reviewer, internal process, or implementation details",
  "  in the final prompt.",
  "- When recent conversation context is provided, do not copy, summarize, or",
  "  repeat the previous user prompt in the final prompt unless the current prompt",
  "  explicitly asks to reuse it or needs a specific referenced detail.",
  "- Always follow the caller's required output format exactly.",
  "- Keep machine-readable section labels in the requested format even when",
  "  translating human-readable content.",
  "",
  "When the prompt is already strong, keep it nearly unchanged and mark it as",
  "ready, but still translate it when an explicit target language is provided.",
  "When important ambiguity remains, provide the best sendable draft you can",
  "and note the missing details.",
].join("\n");

function getLastAssistantMessageText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = extractTextContent(message.content);
    if (text) return text;
  }
  return "";
}

async function runReviewSession(
  ctx: ExtensionContext,
  prompt: string,
  model: Model<any> | undefined,
  thinkingLevel: ReviewerThinkingLevel,
): Promise<ReviewRunResult> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => REVIEWER_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel,
    noTools: "all",
    tools: [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager,
  });

  try {
    await session.prompt(prompt);
    const stats = session.getSessionStats();
    return {
      resultText: getLastAssistantMessageText(session.messages),
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        total: stats.tokens.total,
      },
      cost: stats.cost,
    };
  } finally {
    session.dispose();
  }
}

type ModelInfo = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
};

type ModelRegistryLike = {
  find: (provider: string, modelId: string) => unknown;
  getAvailable?: () => Promise<unknown[]> | unknown[];
  getAll?: () => unknown[];
};

type ResolvedReviewerModel = {
  model?: unknown;
  info?: ModelInfo;
};

async function getAvailableModels(ctx: ExtensionContext): Promise<ModelInfo[]> {
  const registry = ctx.modelRegistry as ModelRegistryLike;
  if (typeof registry.getAvailable === "function") {
    const models = registry.getAvailable();
    if (Array.isArray(models) && models.length > 0) return models as ModelInfo[];
  }
  if (typeof registry.getAll === "function") {
    const models = registry.getAll();
    return Array.isArray(models) ? (models as ModelInfo[]) : [];
  }
  return [];
}

async function getModelCommandCompletions(modelPrefix: string): Promise<AutocompleteItem[] | null> {
  const items: AutocompleteItem[] = [{ value: "model auto", label: "model auto" }];
  if (!completionCtx) return items;

  const models = await getAvailableModels(completionCtx);
  if (models.length === 0) return items;

  const filtered = fuzzyFilter(models, modelPrefix, (model) => {
    const canonical = toCanonicalModelId(model);
    return `${model.id} ${model.provider} ${model.name ?? ""} ${canonical}`;
  });

  if (filtered.length === 0) return items;

  const seen = new Set<string>();
  const modelItems = filtered
    .map((model) => {
      const canonical = toCanonicalModelId(model);
      const description = model.name ? `${model.provider} — ${model.name}` : model.provider;
      return {
        value: `model ${canonical}`,
        label: model.id,
        description,
      } satisfies AutocompleteItem;
    })
    .filter((item) => {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    });

  return [...items, ...modelItems];
}

function scoreModelMatch(query: string, model: ModelInfo): number {
  const normalizedQuery = query.toLowerCase();
  const full = `${model.provider}/${model.id}`.toLowerCase();
  const id = model.id.toLowerCase();
  const name = model.name?.toLowerCase() ?? "";

  if (normalizedQuery === full || normalizedQuery === id) return 100;
  if (full.includes(normalizedQuery) || id.includes(normalizedQuery)) return 75;
  if (name.includes(normalizedQuery)) return 60;

  const parts = normalizedQuery.split(/[\s\-/]+/).filter(Boolean);
  if (parts.length > 0 && parts.every((part) => full.includes(part) || name.includes(part))) return 40;

  return 0;
}

async function resolveModelPattern(
  ctx: ExtensionContext,
  input: string,
): Promise<ResolvedReviewerModel | undefined> {
  const normalizedInput = input.trim();
  if (!normalizedInput) return undefined;

  const registry = ctx.modelRegistry as ModelRegistryLike;
  const availableModels = await getAvailableModels(ctx);
  if (availableModels.length === 0) return undefined;

  let bestMatch: ModelInfo | undefined;
  let bestScore = 0;

  for (const model of availableModels) {
    const score = scoreModelMatch(normalizedInput, model);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = model;
    }
  }

  if (!bestMatch || bestScore <= 0) return undefined;

  return {
    model: registry.find(bestMatch.provider, bestMatch.id) ?? bestMatch,
    info: bestMatch,
  };
}

function getAutoModelCandidates(ctx: ExtensionContext): string[] {
  const provider = ctx.model?.provider?.toLowerCase();
  const providerCandidates = provider ? AUTO_REVIEWER_MODEL_CANDIDATES_BY_PROVIDER[provider] ?? [] : [];
  return Array.from(new Set([...providerCandidates, ...AUTO_REVIEWER_MODEL_CANDIDATES]));
}

async function resolveReviewerModel(
  ctx: ExtensionContext,
  reviewerModel: string | undefined,
): Promise<ResolvedReviewerModel | undefined> {
  if (reviewerModel) {
    const explicit = await resolveModelPattern(ctx, reviewerModel);
    if (explicit) return explicit;
  }

  for (const candidate of getAutoModelCandidates(ctx)) {
    const resolved = await resolveModelPattern(ctx, candidate);
    if (resolved) return resolved;
  }

  if (!ctx.model) return undefined;
  return {
    model: ctx.model,
    info: {
      provider: ctx.model.provider,
      id: ctx.model.id,
      name: ctx.model.name,
      reasoning: ctx.model.reasoning,
    },
  };
}

function normalizeReviewerThinking(
  reviewerThinking: ReviewerThinkingLevel,
  resolvedModel: ResolvedReviewerModel | undefined,
): ReviewerThinkingLevel {
  if (reviewerThinking === "off") return "off";
  if (resolvedModel?.info?.reasoning === false) return "off";
  return reviewerThinking;
}

function toCanonicalModelId(info: ModelInfo): string {
  return `${info.provider}/${info.id}`;
}

function formatModelLabel(model: { name?: string; provider?: string; id?: string } | undefined): string {
  if (!model) return "current session model";
  if (model.name) return model.name;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id ?? "current session model";
}

async function testReviewerConfiguration(
  ctx: ExtensionContext,
  model: Model<any> | undefined,
  thinking: ReviewerThinkingLevel,
): Promise<void> {
  const result = await runReviewSession(ctx, REVIEW_CONFIG_TEST_PROMPT, model, thinking);
  if (!result.resultText.trim()) {
    throw new Error("reviewer test returned no text");
  }
}

function getDefaultReviewPreferences(): ReviewPreferences {
  return {
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    reviewerModel: undefined,
    reviewerThinking: DEFAULT_REVIEWER_THINKING,
    autoSubmit: false,
    englishDialect: DEFAULT_ENGLISH_DIALECT,
    processingText: DEFAULT_PROCESSING_TEXT,
    showProcessingStatus: true,
  };
}

function getReviewPreferencesPath(): string {
  return join(getAgentDir(), "extensions", REVIEW_PREFERENCES_FILE);
}

function normalizeReviewPreferences(
  preferences: Partial<ReviewPreferences> | undefined,
  fallback: ReviewPreferences = getDefaultReviewPreferences(),
): ReviewPreferences {
  const normalized: ReviewPreferences = { ...fallback };

  if (typeof preferences?.targetLanguage === "string" && preferences.targetLanguage.trim()) {
    normalized.targetLanguage = normalizeTargetLanguage(preferences.targetLanguage);
  }

  if (typeof preferences?.reviewerModel === "string") {
    const reviewerModel = preferences.reviewerModel.trim();
    normalized.reviewerModel = !reviewerModel || reviewerModel.toLowerCase() === "auto" ? undefined : reviewerModel;
  }

  if (typeof preferences?.reviewerThinking === "string" && isThinkingLevel(preferences.reviewerThinking)) {
    normalized.reviewerThinking = preferences.reviewerThinking;
  }

  if (typeof preferences?.autoSubmit === "boolean") {
    normalized.autoSubmit = preferences.autoSubmit;
  }

  if (typeof preferences?.englishDialect === "string" && isEnglishDialectMode(preferences.englishDialect)) {
    normalized.englishDialect = preferences.englishDialect;
  }

  if (typeof preferences?.processingText === "string") {
    normalized.processingText = normalizeProcessingText(preferences.processingText);
  }

  if (typeof preferences?.showProcessingStatus === "boolean") {
    normalized.showProcessingStatus = preferences.showProcessingStatus;
  }

  return normalized;
}

function readReviewPreferences(fallback: ReviewPreferences): LoadedReviewPreferences {
  const preferencesPath = getReviewPreferencesPath();
  if (!existsSync(preferencesPath)) {
    return { preferences: normalizeReviewPreferences(undefined, fallback), source: "missing" };
  }

  try {
    const data = JSON.parse(readFileSync(preferencesPath, "utf8")) as Partial<ReviewPreferences>;
    return { preferences: normalizeReviewPreferences(data), source: "file" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: failed to load prompt review preferences from ${preferencesPath}: ${message}\n`);
    return { preferences: normalizeReviewPreferences(undefined, fallback), source: "invalid" };
  }
}

function hasCustomReviewPreferences(preferences: ReviewPreferences): boolean {
  return (
    normalizeTargetLanguage(preferences.targetLanguage) !== DEFAULT_TARGET_LANGUAGE
    || Boolean(preferences.reviewerModel)
    || preferences.reviewerThinking !== DEFAULT_REVIEWER_THINKING
    || preferences.autoSubmit
    || preferences.englishDialect !== DEFAULT_ENGLISH_DIALECT
    || normalizeProcessingText(preferences.processingText) !== DEFAULT_PROCESSING_TEXT
    || !preferences.showProcessingStatus
  );
}

function persistReviewPreferences(preferences: ReviewPreferences): void {
  const preferencesPath = getReviewPreferencesPath();
  const normalized = normalizeReviewPreferences(preferences);
  const serialized = {
    ...normalized,
    reviewerModel: normalized.reviewerModel ?? "auto",
  };

  try {
    mkdirSync(dirname(preferencesPath), { recursive: true });
    writeFileSync(preferencesPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: failed to save prompt review preferences to ${preferencesPath}: ${message}\n`);
  }
}

function readState(ctx: ExtensionContext): ReviewState {
  let state: ReviewState = {
    enabled: true,
    contextMode: DEFAULT_CONTEXT_MODE,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    reviewerModel: undefined,
    reviewerThinking: DEFAULT_REVIEWER_THINKING,
    autoSubmit: false,
    englishDialect: DEFAULT_ENGLISH_DIALECT,
    processingText: DEFAULT_PROCESSING_TEXT,
    showProcessingStatus: true,
  };

  const branch = ctx.sessionManager.getBranch() as Array<{
    type?: string;
    customType?: string;
    data?: unknown;
  }>;

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== REVIEW_STATE_ENTRY) continue;
    const data = entry.data as Partial<ReviewState> | undefined;
    if (typeof data?.enabled === "boolean") {
      state = { ...state, enabled: data.enabled };
    }
    if (typeof data?.contextMode === "string" && isContextMode(data.contextMode)) {
      state = { ...state, contextMode: data.contextMode };
    }
    if (typeof data?.targetLanguage === "string" && data.targetLanguage.trim()) {
      state = { ...state, targetLanguage: normalizeTargetLanguage(data.targetLanguage) };
    }
    if (typeof data?.reviewerModel === "string" && data.reviewerModel.trim()) {
      state = {
        ...state,
        reviewerModel: data.reviewerModel.trim().toLowerCase() === "auto" ? undefined : data.reviewerModel.trim(),
      };
    }
    if (typeof data?.reviewerThinking === "string" && isThinkingLevel(data.reviewerThinking)) {
      state = { ...state, reviewerThinking: data.reviewerThinking };
    }
    if (typeof data?.autoSubmit === "boolean") {
      state = { ...state, autoSubmit: data.autoSubmit };
    }
    if (typeof data?.englishDialect === "string" && isEnglishDialectMode(data.englishDialect)) {
      state = { ...state, englishDialect: data.englishDialect };
    }
    if (typeof data?.processingText === "string") {
      state = { ...state, processingText: normalizeProcessingText(data.processingText) };
    }
    if (typeof data?.showProcessingStatus === "boolean") {
      state = { ...state, showProcessingStatus: data.showProcessingStatus };
    }
  }

  return state;
}

function persistState(pi: ExtensionAPI, state: ReviewState): void {
  const preferences = normalizeReviewPreferences(state);
  pi.appendEntry(REVIEW_STATE_ENTRY, {
    ...state,
    ...preferences,
    reviewerModel: preferences.reviewerModel ?? "auto",
  });
}

function persistCurrentReviewPreferences(
  targetLanguage: string,
  reviewerModel: string | undefined,
  reviewerThinking: ReviewerThinkingLevel,
  autoSubmit: boolean,
  englishDialect: EnglishDialectMode,
  processingText: string,
  showProcessingStatus: boolean,
): void {
  persistReviewPreferences({
    targetLanguage,
    reviewerModel,
    reviewerThinking,
    autoSubmit,
    englishDialect,
    processingText: normalizeProcessingText(processingText),
    showProcessingStatus,
  });
}

function updateStatus(
  ctx: ExtensionContext | undefined,
  enabled: boolean,
  contextMode: ReviewContextMode,
  targetLanguage: string,
  autoSubmit: boolean,
  englishDialect: EnglishDialectMode,
  _processingText: string,
  _showProcessingStatus: boolean,
  _busy: boolean,
): void {
  if (!ctx?.hasUI) return;

  const languageSuffix = isMatchInputTargetLanguage(targetLanguage) ? "" : `/${targetLanguage}`;
  const autoSubmitSuffix = autoSubmit ? "/auto" : "";
  const dialectSuffix = englishDialect === "auto" ? "" : `/${englishDialect}`;

  ctx.ui.setStatus(
    "prompt-review",
    enabled
      ? ctx.ui.theme.fg("accent", `PR:on/${contextMode}${autoSubmitSuffix}${dialectSuffix}${languageSuffix}`)
      : ctx.ui.theme.fg("dim", `PR:off/${contextMode}${autoSubmitSuffix}${dialectSuffix}${languageSuffix}`),
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const candidate = block as { type?: string; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function findLastMessageByRole(
  ctx: ExtensionContext,
  role: "assistant" | "user",
): string | undefined {
  const branch = ctx.sessionManager.getBranch() as Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    if (entry.message?.role !== role) continue;

    const text = extractTextContent(entry.message.content);
    if (text) return text;
  }

  return undefined;
}

function toContextBlock(text: string): ContextBlock {
  if (text.length <= MAX_CONTEXT_CHARS) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: `${text.slice(0, MAX_CONTEXT_CHARS).trimEnd()}\n...[truncated]`,
    truncated: true,
  };
}

function getReviewContext(
  ctx: ExtensionContext,
  prompt: string,
  contextMode: ReviewContextMode,
): ReviewContext | undefined {
  if (contextMode === "off") return undefined;

  const previousUserPrompt = findLastMessageByRole(ctx, "user");
  const assistantReply = findLastMessageByRole(ctx, "assistant");

  if (!previousUserPrompt && !assistantReply) return undefined;

  return {
    previousUserPrompt: previousUserPrompt ? toContextBlock(previousUserPrompt) : undefined,
    assistantReply: assistantReply ? toContextBlock(assistantReply) : undefined,
  };
}

function getContextLabel(context: ReviewContext | undefined): string {
  if (!context?.previousUserPrompt && !context?.assistantReply) return "none";
  if (context.previousUserPrompt && context.assistantReply) return "both";
  if (context.previousUserPrompt) return "previous user prompt only";
  return "assistant reply only";
}

export default function promptReviewExtension(pi: ExtensionAPI) {
  let enabled = true;
  let contextMode: ReviewContextMode = DEFAULT_CONTEXT_MODE;
  let targetLanguage = DEFAULT_TARGET_LANGUAGE;
  let reviewerModel: string | undefined;
  let reviewerThinking: ReviewerThinkingLevel = DEFAULT_REVIEWER_THINKING;
  let autoSubmit = false;
  let englishDialect: EnglishDialectMode = DEFAULT_ENGLISH_DIALECT;
  let processingText = DEFAULT_PROCESSING_TEXT;
  let showProcessingStatus = true;
  let approvedPrompt: string | undefined;
  let activeReview: ActiveReview | undefined;
  let currentCtx: ExtensionContext | undefined;
  let reviewInFlight = false;
  let reviewIndicatorTimer: ReturnType<typeof setInterval> | undefined;
  let reviewIndicatorFrame = 0;

  const clearReviewWidget = (ctx: ExtensionContext | undefined = currentCtx) => {
    if (!ctx?.hasUI) return;
    ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
  };

  const restorePromptToEditor = (text: string, message: string) => {
    if (!currentCtx?.hasUI) return;
    clearReviewWidget(currentCtx);
    activeReview = undefined;
    approvedPrompt = text;
    currentCtx.ui.setEditorText(text);
    currentCtx.ui.notify(message, "info");
    updateStatus(currentCtx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);
  };

  const revertActiveReview = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return false;
    if (!activeReview) {
      ctx.ui.notify("No reviewed prompt is waiting in the editor.", "info");
      return false;
    }

    restorePromptToEditor(
      activeReview.originalText,
      "Original prompt restored. Press Enter to send it, or edit it first.",
    );
    return true;
  };

  const submitEditorWithoutReview = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    completionCtx = ctx;

    if (!ctx.hasUI) return;

    const prompt = ctx.ui.getEditorText();
    if (!prompt.trim()) {
      ctx.ui.notify("No prompt to submit.", "info");
      return;
    }

    if (reviewInFlight) {
      ctx.ui.notify(
        "A prompt review is already running. Wait for it to finish before submitting.",
        "warning",
      );
      return;
    }

    const sendImmediately = ctx.isIdle();

    try {
      pi.sendUserMessage(prompt, sendImmediately ? undefined : { deliverAs: "followUp" });
    } catch (error) {
      ctx.ui.notify(
        `Failed to submit without review: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

    approvedPrompt = undefined;
    activeReview = undefined;
    clearReviewWidget(ctx);
    ctx.ui.setEditorText("");
    updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);
    ctx.ui.notify(sendImmediately ? "Submitted without prompt review." : "Queued without prompt review.", "info");
  };

  const renderReviewProcessingWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const frame = REVIEW_INDICATOR_FRAMES[reviewIndicatorFrame % REVIEW_INDICATOR_FRAMES.length];
    const message = `${frame} ${formatProcessingText(processingText)}`;
    ctx.ui.setWidget(REVIEW_WIDGET_KEY, (_tui, theme) => ({
      render: (width) => wrapTextWithAnsi(theme.fg("warning", message), Math.max(1, width)),
      invalidate: () => {},
    }));
  };

  const setReviewWorkingMessage = (ctx: ExtensionContext, working: boolean) => {
    if (!ctx.hasUI) return;

    if (reviewIndicatorTimer) {
      clearInterval(reviewIndicatorTimer);
      reviewIndicatorTimer = undefined;
    }

    if (!working || !showProcessingStatus) {
      ctx.ui.setWorkingMessage(undefined);
      clearReviewWidget(ctx);
      return;
    }

    ctx.ui.setWorkingMessage(formatProcessingText(processingText));
    reviewIndicatorFrame = 0;
    renderReviewProcessingWidget(ctx);
    reviewIndicatorTimer = setInterval(() => {
      reviewIndicatorFrame += 1;
      renderReviewProcessingWidget(ctx);
    }, 120);
  };

  const showReviewWidget = (
    ctx: ExtensionContext,
    review: ParsedReview,
    changed: boolean,
    contextLabel: string,
    targetLanguage: string,
    reviewerModelLabel: string,
    reviewerThinking: ReviewerThinkingLevel,
    tokens: TokenUsage | undefined,
    cost: number | undefined,
  ) => {
    if (!ctx.hasUI) return;

    const lines = formatReviewWidgetLines(
      review,
      changed,
      contextLabel,
      targetLanguage,
      reviewerModelLabel,
      reviewerThinking,
      tokens,
      cost,
    );
    const themeColor = review.decision === "needs_clarification" ? "warning" : "accent";

    ctx.ui.setWidget(REVIEW_WIDGET_KEY, (_tui, theme) => ({
      render: (width) => lines.flatMap((line) => {
        if (!line) return [line];
        return wrapTextWithAnsi(theme.fg(themeColor, line), Math.max(1, width));
      }),
      invalidate: () => {},
    }));
  };

  const runPromptReview = async (
    ctx: ExtensionContext,
    pending: PendingReview,
    model: Model<any> | undefined,
    thinking: ReviewerThinkingLevel,
  ): Promise<ReviewRunResult> => {
    return await runReviewSession(
      ctx,
      buildReviewPrompt(pending.originalText, pending.targetLanguage, pending.englishDialect, pending.reviewContext),
      model,
      thinking,
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    completionCtx = ctx;
    approvedPrompt = undefined;
    activeReview = undefined;
    reviewInFlight = false;
    clearReviewWidget(ctx);
    setReviewWorkingMessage(ctx, false);

    const state = readState(ctx);
    const loadedPreferences = readReviewPreferences({
      targetLanguage: state.targetLanguage,
      reviewerModel: state.reviewerModel,
      reviewerThinking: state.reviewerThinking,
      autoSubmit: state.autoSubmit,
      englishDialect: state.englishDialect,
      processingText: state.processingText,
      showProcessingStatus: state.showProcessingStatus,
    });

    enabled = state.enabled;
    contextMode = state.contextMode;
    targetLanguage = loadedPreferences.preferences.targetLanguage;
    reviewerModel = loadedPreferences.preferences.reviewerModel;
    reviewerThinking = loadedPreferences.preferences.reviewerThinking;
    autoSubmit = loadedPreferences.preferences.autoSubmit;
    englishDialect = loadedPreferences.preferences.englishDialect;
    processingText = loadedPreferences.preferences.processingText;
    showProcessingStatus = loadedPreferences.preferences.showProcessingStatus;

    if (loadedPreferences.source === "missing" && hasCustomReviewPreferences(loadedPreferences.preferences)) {
      persistReviewPreferences(loadedPreferences.preferences);
    }

    updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    completionCtx = undefined;
    approvedPrompt = undefined;
    activeReview = undefined;
    reviewInFlight = false;
    clearReviewWidget(ctx);
    setReviewWorkingMessage(ctx, false);
    currentCtx = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("prompt-review", undefined);
  });

  pi.registerCommand("prompt-review", {
    description: "Toggle prompt review and configure reviewer context, auto-submit, English dialect, processing status, language, model, and thinking",
    getArgumentCompletions: (prefix) => getCommandCompletions(prefix),
    handler: async (args, ctx) => {
      currentCtx = ctx;
      completionCtx = ctx;
      const tokens = splitArgs(args);
      const [action, value, ...rest] = tokens;

      if (!action || action === "status") {
        const message = buildStatusText(enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "help") {
        const helpText = buildHelpText(enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        if (ctx.hasUI) {
          await ctx.ui.confirm("Prompt review help", helpText);
        } else {
          process.stdout.write(`${helpText}\n`);
        }
        return;
      }

      if (action === "context") {
        if (rest.length > 0) {
          const message = `Too many arguments for /prompt-review context. Use one of: ${CONTEXT_MODE_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!value) {
          const message = buildContextModeText(contextMode);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        if (!isContextMode(normalizeCommand(value))) {
          const message = `Unknown context mode: ${value}. Use one of: ${CONTEXT_MODE_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        contextMode = normalizeCommand(value) as ReviewContextMode;
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

        const message = buildContextModeText(contextMode);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "autosubmit") {
        if (rest.length > 0) {
          const message = `Too many arguments for /prompt-review autosubmit. Use one of: ${AUTOSUBMIT_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!value) {
          const message = buildAutoSubmitText(autoSubmit);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        const normalizedAutoSubmit = normalizeCommand(value);
        if (!AUTOSUBMIT_OPTIONS.includes(normalizedAutoSubmit as typeof AUTOSUBMIT_OPTIONS[number])) {
          const message = `Unknown autosubmit mode: ${value}. Use one of: ${AUTOSUBMIT_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        autoSubmit = normalizedAutoSubmit === "on";
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

        const message = buildAutoSubmitText(autoSubmit);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "dialect") {
        if (rest.length > 0) {
          const message = `Too many arguments for /prompt-review dialect. Use one of: ${ENGLISH_DIALECT_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!value) {
          const message = buildDialectText(englishDialect);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        const normalizedDialect = normalizeCommand(value);
        if (!isEnglishDialectMode(normalizedDialect)) {
          const message = `Unknown English dialect mode: ${value}. Use one of: ${ENGLISH_DIALECT_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        englishDialect = normalizedDialect;
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

        const message = buildDialectText(englishDialect);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "processing") {
        const requestedProcessingText = args.slice(action.length).trim();

        if (!requestedProcessingText) {
          const message = buildProcessingText(processingText);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        processingText = normalizeProcessingText(requestedProcessingText);
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

        const message = buildProcessingText(processingText);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "processing-status") {
        if (rest.length > 0) {
          const message = `Too many arguments for /prompt-review processing-status. Use one of: ${PROCESSING_STATUS_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!value) {
          const message = buildProcessingStatusText(showProcessingStatus);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        const normalizedProcessingStatus = normalizeCommand(value);
        if (!PROCESSING_STATUS_OPTIONS.includes(normalizedProcessingStatus as typeof PROCESSING_STATUS_OPTIONS[number])) {
          const message = `Unknown processing status mode: ${value}. Use one of: ${PROCESSING_STATUS_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        showProcessingStatus = normalizedProcessingStatus === "on";
        if (!showProcessingStatus) setReviewWorkingMessage(ctx, false);
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

        const message = buildProcessingStatusText(showProcessingStatus);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "language") {
        const requestedLanguage = normalizeTargetLanguage([value, ...rest].filter(Boolean).join(" "));

        if (!value) {
          const message = buildTargetLanguageText(targetLanguage);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        targetLanguage = requestedLanguage;
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

        const message = buildTargetLanguageText(targetLanguage);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "model") {
        if (rest.length > 0) {
          const message = "Too many arguments for /prompt-review model. Use /prompt-review model <model-pattern> or /prompt-review model auto.";
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!value) {
          const message = buildModelText(reviewerModel);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        if (normalizeCommand(value) === "auto") {
          reviewerModel = undefined;
          persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
          persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
          const message = buildModelText(reviewerModel);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        const resolvedModel = await resolveModelPattern(ctx, value);
        if (!resolvedModel?.info) {
          const message = `Model not available for prompt review: ${value}. Try /prompt-review model auto or an available model pattern.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        const previousReviewerModel = reviewerModel;
        const effectiveReviewerThinking = normalizeReviewerThinking(reviewerThinking, resolvedModel);

        try {
          await testReviewerConfiguration(ctx, resolvedModel.model as Model<any> | undefined, effectiveReviewerThinking);
        } catch (error) {
          const previousLabel = previousReviewerModel ?? "auto";
          const message = `Prompt reviewer model test failed for ${toCanonicalModelId(resolvedModel.info)} (thinking: ${effectiveReviewerThinking}): ${error instanceof Error ? error.message : String(error)}. Keeping current reviewer model: ${previousLabel}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "warning");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        reviewerModel = toCanonicalModelId(resolvedModel.info);
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);

        const message = buildModelText(reviewerModel);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "thinking") {
        if (rest.length > 0) {
          const message = `Too many arguments for /prompt-review thinking. Use one of: ${THINKING_LEVEL_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!value) {
          const message = buildThinkingText(reviewerThinking);
          if (ctx.hasUI) {
            ctx.ui.notify(message, "info");
          } else {
            process.stdout.write(`${message}\n`);
          }
          return;
        }

        if (!isThinkingLevel(normalizeCommand(value))) {
          const message = `Unknown thinking level: ${value}. Use one of: ${THINKING_LEVEL_OPTIONS.join(", ")}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        const requestedReviewerThinking = normalizeCommand(value) as ReviewerThinkingLevel;
        const previousReviewerThinking = reviewerThinking;
        const resolvedReviewerModel = await resolveReviewerModel(ctx, reviewerModel);
        const effectiveReviewerThinking = normalizeReviewerThinking(requestedReviewerThinking, resolvedReviewerModel);

        try {
          await testReviewerConfiguration(
            ctx,
            resolvedReviewerModel?.model as Model<any> | undefined,
            effectiveReviewerThinking,
          );
        } catch (error) {
          const modelLabel = formatModelLabel(
            (resolvedReviewerModel?.info as { name?: string; provider?: string; id?: string } | undefined)
              ?? (resolvedReviewerModel?.model as { name?: string; provider?: string; id?: string } | undefined)
              ?? ctx.model,
          );
          const message = `Prompt reviewer thinking test failed for ${modelLabel} (thinking: ${effectiveReviewerThinking}): ${error instanceof Error ? error.message : String(error)}. Keeping current reviewer thinking: ${previousReviewerThinking}.`;
          if (ctx.hasUI) {
            ctx.ui.notify(message, "warning");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        reviewerThinking = requestedReviewerThinking;
        persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
        persistCurrentReviewPreferences(targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);

        const message = buildThinkingText(reviewerThinking);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "revert") {
        if (rest.length > 0 || value) {
          const message = "Too many arguments for /prompt-review revert.";
          if (ctx.hasUI) {
            ctx.ui.notify(message, "error");
          } else {
            process.stderr.write(`${message}\n`);
          }
          return;
        }

        if (!ctx.hasUI) {
          process.stdout.write("/prompt-review revert is only available in interactive mode.\n");
          return;
        }

        revertActiveReview(ctx);
        return;
      }

      if (rest.length > 0 || value) {
        const message = `Unknown option: ${args}. Use /prompt-review help.`;
        if (ctx.hasUI) {
          ctx.ui.notify(message, "error");
        } else {
          process.stderr.write(`${message}\n`);
        }
        return;
      }

      if (!["on", "off", "toggle"].includes(action)) {
        const message = `Unknown option: ${args}. Use /prompt-review help.`;
        if (ctx.hasUI) {
          ctx.ui.notify(message, "error");
        } else {
          process.stderr.write(`${message}\n`);
        }
        return;
      }

      enabled = action === "toggle" ? !enabled : action === "on";
      if (!enabled) {
        approvedPrompt = undefined;
        activeReview = undefined;
        clearReviewWidget(ctx);
      }
      persistState(pi, { enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus });
      updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, reviewInFlight);

      const message = buildStatusText(enabled, contextMode, targetLanguage, reviewerModel, reviewerThinking, autoSubmit, englishDialect, processingText, showProcessingStatus);
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      } else {
        process.stdout.write(`${message}\n`);
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("r"), {
    description: "Restore the original prompt after prompt review",
    handler: async (ctx) => {
      revertActiveReview(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlShift("s"), {
    description: "Submit the current prompt without prompt review",
    handler: async (ctx) => {
      submitEditorWithoutReview(ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    currentCtx = ctx;
    completionCtx = ctx;

    if (!ctx.hasUI) return { action: "continue" };
    if (!enabled) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.images && event.images.length > 0) return { action: "continue" };
    if (!event.text.trim()) return { action: "continue" };

    if (activeReview && event.text !== activeReview.reviewedText) {
      activeReview = undefined;
      clearReviewWidget(ctx);
    }

    if (event.text.startsWith("\\")) {
      approvedPrompt = undefined;
      return { action: "transform", text: event.text.slice(1) };
    }

    if (event.text.startsWith("/") || event.text.startsWith("!")) {
      approvedPrompt = undefined;
      return { action: "continue" };
    }

    if (approvedPrompt && event.text === approvedPrompt) {
      approvedPrompt = undefined;
      activeReview = undefined;
      clearReviewWidget(ctx);
      return { action: "continue" };
    }

    if (reviewInFlight) {
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify("A prompt review is already running. Wait for it to finish first.", "warning");
      return { action: "handled" };
    }

    clearReviewWidget(ctx);
    activeReview = undefined;

    const reviewContext = getReviewContext(ctx, event.text, contextMode);
    const resolvedReviewerModel = await resolveReviewerModel(ctx, reviewerModel);
    const effectiveReviewerThinking = normalizeReviewerThinking(reviewerThinking, resolvedReviewerModel);
    const reviewerModelMeta = (resolvedReviewerModel?.info as { name?: string; provider?: string; id?: string } | undefined)
      ?? (resolvedReviewerModel?.model as { name?: string; provider?: string; id?: string } | undefined)
      ?? ctx.model;

    const pending: PendingReview = {
      originalText: event.text,
      contextLabel: getContextLabel(reviewContext),
      targetLanguage,
      reviewerModelLabel: formatModelLabel(reviewerModelMeta),
      reviewerThinking: effectiveReviewerThinking,
      englishDialect,
      reviewContext,
      retryCount: 0,
    };

    approvedPrompt = undefined;
    reviewInFlight = true;
    setReviewWorkingMessage(ctx, true);
    updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, true);
    ctx.ui.notify(
      reviewContext ? "Reviewing prompt with recent conversation context…" : "Reviewing prompt…",
      "info",
    );

    let reviewRun: ReviewRunResult;
    try {
      reviewRun = await runPromptReview(ctx, pending, resolvedReviewerModel?.model as Model<any> | undefined, effectiveReviewerThinking);
    } catch (error) {
      reviewInFlight = false;
      setReviewWorkingMessage(ctx, false);
      updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
      restorePromptToEditor(
        pending.originalText,
        `Prompt review failed with ${pending.reviewerModelLabel} (thinking: ${pending.reviewerThinking}): ${error instanceof Error ? error.message : String(error)}. Original prompt restored. Press Enter again to send it.`,
      );
      return { action: "handled" };
    }

    if (!reviewRun.resultText) {
      if (!currentCtx?.model) {
        reviewInFlight = false;
        setReviewWorkingMessage(ctx, false);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
        restorePromptToEditor(
          pending.originalText,
          `Prompt review failed with ${pending.reviewerModelLabel} (thinking: ${pending.reviewerThinking}): no result was returned by the reviewer. Original prompt restored. Press Enter again to send it.`,
        );
        return { action: "handled" };
      }

      currentCtx.ui.notify(
        `Prompt reviewer returned no text with ${pending.reviewerModelLabel} (thinking: ${pending.reviewerThinking}). Retrying once with ${formatModelLabel(currentCtx.model)} (thinking: off)…`,
        "warning",
      );

      const retryPending: PendingReview = {
        ...pending,
        reviewerModelLabel: formatModelLabel(currentCtx.model),
        reviewerThinking: "off",
        retryCount: 1,
      };

      try {
        reviewRun = await runPromptReview(ctx, retryPending, currentCtx.model, "off");
        pending.reviewerModelLabel = retryPending.reviewerModelLabel;
        pending.reviewerThinking = retryPending.reviewerThinking;
      } catch (error) {
        reviewInFlight = false;
        setReviewWorkingMessage(ctx, false);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
        restorePromptToEditor(
          pending.originalText,
          `Prompt review failed with ${retryPending.reviewerModelLabel} (thinking: ${retryPending.reviewerThinking}): ${error instanceof Error ? error.message : String(error)}. Original prompt restored. Press Enter again to send it.`,
        );
        return { action: "handled" };
      }

      if (!reviewRun.resultText) {
        reviewInFlight = false;
        setReviewWorkingMessage(ctx, false);
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
        restorePromptToEditor(
          pending.originalText,
          `Prompt review failed with ${pending.reviewerModelLabel} (thinking: ${pending.reviewerThinking}): no result was returned by the reviewer. Original prompt restored. Press Enter again to send it.`,
        );
        return { action: "handled" };
      }
    }

    reviewInFlight = false;
    setReviewWorkingMessage(ctx, false);
    updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);

    const review = parseReview(reviewRun.resultText);
    const useBritishEnglish = shouldUseBritishEnglish(pending.targetLanguage, pending.englishDialect);
    const applyConfiguredDialect = (text: string) => {
      if (useBritishEnglish) return applyBritishEnglish(text);
      return text;
    };
    const rawCandidatePrompt = review.prompt || pending.originalText;
    const candidatePrompt = applyConfiguredDialect(rawCandidatePrompt);
    if (useBritishEnglish) {
      review.questions = review.questions.map((question) => applyConfiguredDialect(question));
    }
    const changed = candidatePrompt.trim() !== pending.originalText.trim();

    if (autoSubmit && review.decision !== "needs_clarification") {
      const sendImmediately = ctx.isIdle();

      try {
        pi.sendUserMessage(candidatePrompt, sendImmediately ? undefined : { deliverAs: "followUp" });
      } catch (error) {
        approvedPrompt = candidatePrompt;
        activeReview = {
          originalText: pending.originalText,
          reviewedText: candidatePrompt,
        };
        ctx.ui.setEditorText(candidatePrompt);
        showReviewWidget(
          ctx,
          review,
          changed,
          pending.contextLabel,
          pending.targetLanguage,
          pending.reviewerModelLabel,
          pending.reviewerThinking,
          reviewRun.tokens,
          reviewRun.cost,
        );
        ctx.ui.notify(
          `Prompt review auto-submit failed: ${error instanceof Error ? error.message : String(error)}. Reviewed prompt loaded for manual submission.`,
          "error",
        );
        updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
        return { action: "handled" };
      }

      approvedPrompt = undefined;
      activeReview = undefined;
      clearReviewWidget(ctx);
      ctx.ui.setEditorText("");
      ctx.ui.notify(
        `Reviewed prompt ${changed ? "updated and " : ""}auto-submitted${sendImmediately ? "" : " as a follow-up"}.`,
        "info",
      );
      updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);
      return { action: "handled" };
    }

    approvedPrompt = candidatePrompt;
    activeReview = {
      originalText: pending.originalText,
      reviewedText: candidatePrompt,
    };
    ctx.ui.setEditorText(candidatePrompt);
    showReviewWidget(
      ctx,
      review,
      changed,
      pending.contextLabel,
      pending.targetLanguage,
      pending.reviewerModelLabel,
      pending.reviewerThinking,
      reviewRun.tokens,
      reviewRun.cost,
    );
    ctx.ui.notify(
      autoSubmit
        ? `Prompt review needs clarification, so auto-submit was skipped. Press Enter to send the reviewed prompt, use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original, or press ${SUBMIT_WITHOUT_REVIEW_SHORTCUT_LABEL} to submit without review.`
        : `Reviewed prompt loaded. Press Enter to send it, use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original, or press ${SUBMIT_WITHOUT_REVIEW_SHORTCUT_LABEL} to submit without review.`,
      autoSubmit ? "warning" : "info",
    );
    updateStatus(ctx, enabled, contextMode, targetLanguage, autoSubmit, englishDialect, processingText, showProcessingStatus, false);

    return { action: "handled" };
  });
}
