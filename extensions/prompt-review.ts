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
import { fuzzyFilter, Key, type AutocompleteItem } from "@mariozechner/pi-tui";

type ReviewContextMode = "off" | "smart" | "always";
type ReviewerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ReviewState = {
  enabled: boolean;
  contextMode: ReviewContextMode;
  reviewerModel?: string;
  reviewerThinking: ReviewerThinkingLevel;
};

type PendingReview = {
  originalText: string;
  contextLabel: string;
  reviewerModelLabel: string;
  reviewerThinking: ReviewerThinkingLevel;
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

const ROOT_COMMAND_OPTIONS = ["on", "off", "toggle", "status", "help", "context", "model", "thinking", "revert"] as const;
const CONTEXT_MODE_OPTIONS = ["off", "smart", "always"] as const;
const THINKING_LEVEL_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_CONTEXT_MODE: ReviewContextMode = "smart";
const DEFAULT_REVIEWER_THINKING: ReviewerThinkingLevel = "off";
const REVIEW_STATE_ENTRY = "prompt-review:state";
const REVIEW_WIDGET_KEY = "prompt-review";
const REVERT_SHORTCUT_LABEL = "Ctrl+Alt+R";
const REVIEW_CONFIG_TEST_PROMPT = "Reply with exactly OK and nothing else.";
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
const REFERENTIAL_PROMPT_PATTERN =
  /\b(this|that|it|them|they|these|those|same|again|continue|continuing|shorter|longer|rewrite|reword|rephrase|fix|improve|refine|polish|expand|trim|condense|summari[sz]e|use the same|based on|from above|from earlier|previous|last reply|last response|response above|above)\b/i;

let completionCtx: ExtensionContext | undefined;

function splitArgs(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase();
}

function isContextMode(value: string): value is ReviewContextMode {
  return CONTEXT_MODE_OPTIONS.includes(value as ReviewContextMode);
}

function isThinkingLevel(value: string): value is ReviewerThinkingLevel {
  return THINKING_LEVEL_OPTIONS.includes(value as ReviewerThinkingLevel);
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

  if (tokens.length > 2) return null;

  if (tokens[0] === "context") {
    const modePrefix = hasTrailingSpace ? "" : (tokens[1] ?? "");
    const values = CONTEXT_MODE_OPTIONS
      .filter((value) => value.startsWith(modePrefix))
      .map((value) => ({ value: `context ${value}`, label: `context ${value}` }));
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
  reviewerModel: string | undefined,
  reviewerThinking: ReviewerThinkingLevel,
): string {
  return [
    "Usage:",
    "  /prompt-review on",
    "  /prompt-review off",
    "  /prompt-review toggle",
    "  /prompt-review status",
    "  /prompt-review context",
    "  /prompt-review context off|smart|always",
    "  /prompt-review model",
    "  /prompt-review model auto",
    "  /prompt-review model <model-pattern>",
    "  /prompt-review thinking",
    "  /prompt-review thinking off|minimal|low|medium|high|xhigh",
    "  /prompt-review revert",
    "",
    `Current mode: ${enabled ? "enabled" : "disabled"}`,
    `Current context mode: ${contextMode}`,
    `Current reviewer model: ${reviewerModel ?? "auto"}`,
    `Current reviewer thinking: ${reviewerThinking}`,
    "",
    "When enabled:",
    "- normal prompts are intercepted before they reach the main session",
    "- a lightweight review session reviews and rewrites the prompt",
    "- the reviewed prompt is loaded back into the editor",
    "- review details are shown above the editor",
    `- press Enter to send the reviewed prompt, or use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original`,
    "",
    "Context modes:",
    "- off: do not send recent conversation context",
    "- smart: send the previous user prompt and last assistant reply only for referential follow-ups",
    "- always: always send the previous user prompt and last assistant reply when they exist",
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
    "Bypasses:",
    "- slash commands and !bash shortcuts are not reviewed",
    "- prompts with image attachments are sent directly",
    "- prefix a prompt with \\ to skip review once",
    "",
    "Tip:",
    "- edit .pi/extensions/prompt-review.ts to change the reviewer behavior",
  ].join("\n");
}

function buildStatusText(
  enabled: boolean,
  contextMode: ReviewContextMode,
  reviewerModel: string | undefined,
  reviewerThinking: ReviewerThinkingLevel,
): string {
  return `prompt review: ${enabled ? "enabled" : "disabled"} (context: ${contextMode}, model: ${reviewerModel ?? "auto"}, thinking: ${reviewerThinking})`;
}

function buildContextModeText(contextMode: ReviewContextMode): string {
  return `prompt review context: ${contextMode}`;
}

function buildModelText(reviewerModel: string | undefined): string {
  return `prompt review model: ${reviewerModel ?? "auto"}`;
}

function buildThinkingText(reviewerThinking: ReviewerThinkingLevel): string {
  return `prompt review thinking: ${reviewerThinking}`;
}

function buildReviewPrompt(prompt: string, context?: ReviewContext): string {
  const hasContext = Boolean(context?.previousUserPrompt || context?.assistantReply);

  return [
    "Review the following user prompt before it is sent to the main pi session.",
    "Improve clarity, constraints, expected output, and sequencing while preserving the user's intent and language.",
    "Do not answer the task itself.",
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
    "- Never answer the user's task.",
    "- Always include a complete sendable prompt between FINAL_PROMPT_START and FINAL_PROMPT_END.",
    "- If the prompt is already good, keep it nearly unchanged and use DECISION: ready.",
    "- Use DECISION: needs_clarification only when a missing detail would materially improve the result.",
    "- Always correct obvious typos and spelling mistakes in the final prompt.",
    "- If there are no useful clarification questions, leave the QUESTIONS section empty. Do not write 'None'.",
    "- Do not mention this reviewer, subagents, or internal process inside the final prompt.",
    hasContext
      ? "- Treat any recent conversation context as reference only. Use it only to resolve referential wording in the new prompt."
      : null,
    hasContext ? "" : null,
    context?.previousUserPrompt
      ? `PREVIOUS_USER_PROMPT${context.previousUserPrompt.truncated ? " (truncated)" : ""}:`
      : null,
    context?.previousUserPrompt ? "PREVIOUS_USER_PROMPT_START" : null,
    context?.previousUserPrompt?.text,
    context?.previousUserPrompt ? "PREVIOUS_USER_PROMPT_END" : null,
    context?.previousUserPrompt && context?.assistantReply ? "" : null,
    context?.assistantReply
      ? `RECENT_ASSISTANT_REPLY${context.assistantReply.truncated ? " (truncated)" : ""}:`
      : null,
    context?.assistantReply ? "ASSISTANT_REPLY_START" : null,
    context?.assistantReply?.text,
    context?.assistantReply ? "ASSISTANT_REPLY_END" : null,
    hasContext ? "" : null,
    "PROMPT TO REVIEW:",
    "USER_PROMPT_START",
    prompt,
    "USER_PROMPT_END",
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
  reviewerModelLabel: string,
  reviewerThinking: ReviewerThinkingLevel,
  tokens: TokenUsage | undefined,
  cost: number | undefined,
): string[] {
  const metadataParts = [
    `context: ${contextLabel}`,
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

  lines.push(`Press Enter to send it, or use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original prompt.`);

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
  "## Rules",
  "",
  "- Preserve the user's intent.",
  "- Preserve the user's language and tone unless clarity requires a small",
  "  change.",
  "- Do not answer the task itself.",
  "- Do not add extra goals the user did not ask for.",
  "- Improve clarity, sequencing, constraints, expected output, and missing",
  "  context.",
  "- Always correct obvious typos and spelling mistakes.",
  "- Keep the final prompt concise and practical.",
  "- Never mention this reviewer, internal process, or implementation details",
  "  in the final prompt.",
  "- Always follow the caller's required output format exactly.",
  "",
  "When the prompt is already strong, keep it nearly unchanged and mark it as",
  "ready.",
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

function readState(ctx: ExtensionContext): ReviewState {
  let state: ReviewState = {
    enabled: true,
    contextMode: DEFAULT_CONTEXT_MODE,
    reviewerModel: undefined,
    reviewerThinking: DEFAULT_REVIEWER_THINKING,
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
    if (typeof data?.reviewerModel === "string" && data.reviewerModel.trim()) {
      state = {
        ...state,
        reviewerModel: data.reviewerModel.trim() === "auto" ? undefined : data.reviewerModel.trim(),
      };
    }
    if (typeof data?.reviewerThinking === "string" && isThinkingLevel(data.reviewerThinking)) {
      state = { ...state, reviewerThinking: data.reviewerThinking };
    }
  }

  return state;
}

function persistState(pi: ExtensionAPI, state: ReviewState): void {
  pi.appendEntry(REVIEW_STATE_ENTRY, {
    ...state,
    reviewerModel: state.reviewerModel ?? "auto",
  });
}

function updateStatus(
  ctx: ExtensionContext | undefined,
  enabled: boolean,
  contextMode: ReviewContextMode,
  busy: boolean,
): void {
  if (!ctx?.hasUI) return;

  if (busy) {
    ctx.ui.setStatus("prompt-review", ctx.ui.theme.fg("warning", `PR:reviewing/${contextMode}`));
    return;
  }

  ctx.ui.setStatus(
    "prompt-review",
    enabled
      ? ctx.ui.theme.fg("accent", `PR:on/${contextMode}`)
      : ctx.ui.theme.fg("dim", `PR:off/${contextMode}`),
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

function shouldIncludeAssistantContext(prompt: string): boolean {
  return REFERENTIAL_PROMPT_PATTERN.test(prompt.trim());
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
  if (contextMode === "smart" && !shouldIncludeAssistantContext(prompt)) return undefined;

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
  let reviewerModel: string | undefined;
  let reviewerThinking: ReviewerThinkingLevel = DEFAULT_REVIEWER_THINKING;
  let approvedPrompt: string | undefined;
  let activeReview: ActiveReview | undefined;
  let currentCtx: ExtensionContext | undefined;
  let reviewInFlight = false;

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
    updateStatus(currentCtx, enabled, contextMode, reviewInFlight);
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

  const showReviewWidget = (
    ctx: ExtensionContext,
    review: ParsedReview,
    changed: boolean,
    contextLabel: string,
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
      reviewerModelLabel,
      reviewerThinking,
      tokens,
      cost,
    );
    const themeColor = review.decision === "needs_clarification" ? "warning" : "accent";

    ctx.ui.setWidget(REVIEW_WIDGET_KEY, (_tui, theme) => ({
      render: () => lines.map((line) => (line ? theme.fg(themeColor, line) : line)),
      invalidate: () => {},
    }));
  };

  const runPromptReview = async (
    ctx: ExtensionContext,
    pending: PendingReview,
    model: Model<any> | undefined,
    thinking: ReviewerThinkingLevel,
  ): Promise<ReviewRunResult> => {
    return await runReviewSession(ctx, buildReviewPrompt(pending.originalText, pending.reviewContext), model, thinking);
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    completionCtx = ctx;
    approvedPrompt = undefined;
    activeReview = undefined;
    reviewInFlight = false;
    clearReviewWidget(ctx);

    const state = readState(ctx);
    enabled = state.enabled;
    contextMode = state.contextMode;
    reviewerModel = state.reviewerModel;
    reviewerThinking = state.reviewerThinking;
    updateStatus(ctx, enabled, contextMode, false);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    completionCtx = undefined;
    approvedPrompt = undefined;
    activeReview = undefined;
    reviewInFlight = false;
    clearReviewWidget(ctx);
    currentCtx = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("prompt-review", undefined);
  });

  pi.registerCommand("prompt-review", {
    description: "Toggle prompt review and configure reviewer context, model, and thinking",
    getArgumentCompletions: (prefix) => getCommandCompletions(prefix),
    handler: async (args, ctx) => {
      currentCtx = ctx;
      completionCtx = ctx;
      const tokens = splitArgs(args);
      const [action, value, ...rest] = tokens;

      if (!action || action === "status") {
        const message = buildStatusText(enabled, contextMode, reviewerModel, reviewerThinking);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          process.stdout.write(`${message}\n`);
        }
        return;
      }

      if (action === "help") {
        const helpText = buildHelpText(enabled, contextMode, reviewerModel, reviewerThinking);
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
        persistState(pi, { enabled, contextMode, reviewerModel, reviewerThinking });
        updateStatus(ctx, enabled, contextMode, reviewInFlight);

        const message = buildContextModeText(contextMode);
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
          persistState(pi, { enabled, contextMode, reviewerModel, reviewerThinking });
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
        persistState(pi, { enabled, contextMode, reviewerModel, reviewerThinking });

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
        persistState(pi, { enabled, contextMode, reviewerModel, reviewerThinking });

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
      persistState(pi, { enabled, contextMode, reviewerModel, reviewerThinking });
      updateStatus(ctx, enabled, contextMode, reviewInFlight);

      const message = buildStatusText(enabled, contextMode, reviewerModel, reviewerThinking);
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
      reviewerModelLabel: formatModelLabel(reviewerModelMeta),
      reviewerThinking: effectiveReviewerThinking,
      reviewContext,
      retryCount: 0,
    };

    approvedPrompt = undefined;
    reviewInFlight = true;
    updateStatus(ctx, enabled, contextMode, true);
    ctx.ui.notify(
      reviewContext ? "Reviewing prompt with recent conversation context…" : "Reviewing prompt…",
      "info",
    );

    let reviewRun: ReviewRunResult;
    try {
      reviewRun = await runPromptReview(ctx, pending, resolvedReviewerModel?.model as Model<any> | undefined, effectiveReviewerThinking);
    } catch (error) {
      reviewInFlight = false;
      updateStatus(ctx, enabled, contextMode, false);
      restorePromptToEditor(
        pending.originalText,
        `Prompt review failed with ${pending.reviewerModelLabel} (thinking: ${pending.reviewerThinking}): ${error instanceof Error ? error.message : String(error)}. Original prompt restored. Press Enter again to send it.`,
      );
      return { action: "handled" };
    }

    if (!reviewRun.resultText) {
      if (!currentCtx?.model) {
        reviewInFlight = false;
        updateStatus(ctx, enabled, contextMode, false);
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
        updateStatus(ctx, enabled, contextMode, false);
        restorePromptToEditor(
          pending.originalText,
          `Prompt review failed with ${retryPending.reviewerModelLabel} (thinking: ${retryPending.reviewerThinking}): ${error instanceof Error ? error.message : String(error)}. Original prompt restored. Press Enter again to send it.`,
        );
        return { action: "handled" };
      }

      if (!reviewRun.resultText) {
        reviewInFlight = false;
        updateStatus(ctx, enabled, contextMode, false);
        restorePromptToEditor(
          pending.originalText,
          `Prompt review failed with ${pending.reviewerModelLabel} (thinking: ${pending.reviewerThinking}): no result was returned by the reviewer. Original prompt restored. Press Enter again to send it.`,
        );
        return { action: "handled" };
      }
    }

    reviewInFlight = false;
    updateStatus(ctx, enabled, contextMode, false);

    const review = parseReview(reviewRun.resultText);
    const candidatePrompt = review.prompt || pending.originalText;
    const changed = candidatePrompt.trim() !== pending.originalText.trim();

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
      pending.reviewerModelLabel,
      pending.reviewerThinking,
      reviewRun.tokens,
      reviewRun.cost,
    );
    ctx.ui.notify(
      `Reviewed prompt loaded. Press Enter to send it, or use /prompt-review revert or ${REVERT_SHORTCUT_LABEL} to restore the original.`,
      "info",
    );
    updateStatus(ctx, enabled, contextMode, false);

    return { action: "handled" };
  });
}
