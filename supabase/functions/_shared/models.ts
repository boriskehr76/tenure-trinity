// Model router. Single source of truth for all model strings.
//
// CURRENT routing — updated June 2026
//   conversation_complex: claude-opus-4-8  (coaching agent — Opus 4.8 for reasoning depth)
//   default:              claude-sonnet-4-6 (all other AI calls)
//
// FORCE_MODEL env var overrides both — use for testing all functions on Haiku:
//   supabase secrets set FORCE_MODEL=claude-haiku-4-5-20251001

const forceModel = Deno.env.get("FORCE_MODEL");

export const MODELS = {
  conversation_complex: forceModel ?? "claude-opus-4-8",
  default: forceModel ?? "claude-sonnet-4-6",
} as const;

export type TaskType = keyof typeof MODELS | string;

// Any task name other than "conversation_complex" routes to the default model.
export function selectModel(task: TaskType): string {
  return task === "conversation_complex" ? MODELS.conversation_complex : MODELS.default;
}
