import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk";
import { MODELS } from "../_shared/models.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const AXES = ["structure", "collaboration", "feedback", "pace", "leadership"] as const;

// Static prefix — must stay byte-identical across requests so the
// cache_control breakpoint below keeps hitting. Dynamic context (profile
// state, session memory) goes in a second, uncached system block.
const SYSTEM_PROMPT = `<role>
You are Tenure's profile coach — a direct, curious advisor who helps UX/UI designers understand how they work best through natural conversation. You are NOT evaluating the candidate. There are no right or wrong answers — only conditions for performing well.
</role>

<goal>
Done looks like: an accurate five-axis working-style profile, grounded in concrete stories rather than self-report, that the candidate recognises as true. Each session should surface evidence for at least one axis and leave the candidate feeling understood, not assessed. A separate system extracts axis scores from the transcript — your only job is the conversation itself.
</goal>

<axes>
- structure: 0 = thrives in ambiguity | 1 = needs clear process and brief
- collaboration: 0 = deep solo thinking | 1 = co-creative, thinks through exchange
- feedback: 0 = self-directed, internal calibration | 1 = needs frequent explicit signals
- pace: 0 = deliberate, thorough | 1 = fast iteration, comfortable with imperfect
- leadership: 0 = deep IC craft | 1 = energised by growing and directing others
</axes>

<conversation_method>
The four founding questions form the spine of the first conversations. Weave them in naturally — never as a form:
1. "Tell me about a project you're genuinely proud of — not the most impressive, the one that felt right."
2. "Tell me about a time you struggled to do your best work. What was missing?"
3. "When you finish a piece of work, how do you know it's good?"
4. "Five years from now — deeper into the craft, or growing other designers?"

Method:
- Ask ONE question at a time. Never two.
- After abstract self-report, anchor to a specific moment: "Tell me about a time when..."
- Use the energy probe when useful: "Was that energising or draining?"
- Surface contradictions gently and without judgment: "You mentioned X earlier — but what you just described sounds different. How do you think about that?" Treat both ends as real data, not a conflict to resolve.
- Follow "it depends" with "It depends on what?"
- Never say "great answer" or anything that sounds like evaluation.
- Never suggest one end of an axis is better than another.
- After 4-6 exchanges: summarise what you have understood and ask if it feels accurate.
- After 3 short or guarded answers in a row: offer to stop and show the diagram with its gaps named, instead of pushing.
- If the candidate has corrected an axis (see context), acknowledge the correction once, naturally, and build on it. Do not re-litigate it.
</conversation_method>

<session_memory>
If prior-session context is provided, open by referencing something specific the candidate said before — "Last time you mentioned..." — and continue from there. Never restart from question one with a returning candidate. If no prior context exists, this is a first conversation: open with founding question 1.
</session_memory>

<output_format>
Plain conversational text only. No headings, no lists, no scores, no XML.
</output_format>

<response_style>
Lead with the substance. 2-3 sentences, under 80 words, ending in exactly one question. Cut narration of your reasoning and options not pursued. Do not survey choices — make a move.
When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate decisions already made, or narrate options you will not pursue in user-facing messages.
</response_style>`;

interface ProfileRow {
  [key: string]: unknown;
  profile_summary: string | null;
  name: string | null;
}

function buildDynamicContext(
  profile: ProfileRow | null,
  history: { role: string; content: string }[],
  isNewSession: boolean,
): string {
  const parts: string[] = [];

  if (profile) {
    const axisLines = AXES.map((axis) => {
      const baseline = profile[`axis_${axis}_baseline`] as number | null;
      const confidence = (profile[`axis_${axis}_confidence`] as number | null) ?? 0;
      return baseline == null
        ? `- ${axis}: no evidence yet`
        : `- ${axis}: baseline ${baseline.toFixed(2)} (confidence ${confidence.toFixed(2)})`;
    });
    parts.push(`<profile_state>\nCandidate: ${profile.name || "unknown"}\n${axisLines.join("\n")}${
      profile.profile_summary ? `\nSummary so far: ${profile.profile_summary}` : ""
    }\n</profile_state>`);
  }

  if (isNewSession && history.length > 0) {
    // Compact recap of the previous session so the agent can open with
    // "last time you mentioned..." without hallucinating.
    const recap = history
      .slice(-10)
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join("\n");
    parts.push(`<previous_sessions>\nThis is a RETURNING candidate. Recent exchanges from prior sessions:\n${recap}\n</previous_sessions>`);
  } else if (history.length === 0) {
    parts.push("<previous_sessions>\nFirst conversation — no prior history.\n</previous_sessions>");
  }

  return parts.join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization header" }, 401);
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );

  if (authError || !user) {
    return json({ error: "Invalid or expired token" }, 401);
  }

  const userId = user.id;

  let body: { message: string; job_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { message, job_id } = body;
  if (!message || typeof message !== "string") {
    return json({ error: "message is required" }, 400);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  let historyQuery = supabase
    .from("conversations")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (job_id) {
    historyQuery = historyQuery.or(`job_id.eq.${job_id},job_id.is.null`);
  } else {
    historyQuery = historyQuery.is("job_id", null);
  }

  const { data: historyRows } = await historyQuery;
  const history = (historyRows ?? []).reverse() as {
    role: string;
    content: string;
    created_at: string;
  }[];

  // A gap of 30+ minutes since the last message means a new session — the
  // agent should open by referencing what was discussed before.
  const lastMessageAt = history.length > 0
    ? new Date(history[history.length - 1].created_at).getTime()
    : 0;
  const isNewSession = history.length > 0 &&
    Date.now() - lastMessageAt > 30 * 60 * 1000;

  const messages: Anthropic.MessageParam[] = [
    ...history.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    })),
    { role: "user" as const, content: message },
  ];

  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  let aiMessage;
  try {
    aiMessage = await anthropic.messages.create({
      model: MODELS.conversation_complex,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: buildDynamicContext(profile, history, isNewSession),
        },
      ],
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (err) {
    return json({ error: "AI request failed", details: String(err) }, 502);
  }

  // With adaptive thinking the first block can be a thinking block —
  // find the text block instead of assuming content[0].
  const textBlock = aiMessage.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return json({ error: "No text in AI response" }, 500);
  }

  const reply = textBlock.text;

  const { error: insertError } = await supabase.from("conversations").insert([
    { user_id: userId, job_id: job_id ?? null, role: "user", content: message },
    { user_id: userId, job_id: job_id ?? null, role: "assistant", content: reply },
  ]);

  if (insertError) {
    return json({ error: "Failed to save conversation", details: insertError.message }, 500);
  }

  // Silent extract-profile after each turn. Fire and forget — but the runtime
  // kills pending work once the response returns, so the promise must be
  // handed to EdgeRuntime.waitUntil to actually complete.
  const internalSecret = Deno.env.get("INTERNAL_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (internalSecret && supabaseUrl) {
    const extraction = fetch(`${supabaseUrl}/functions/v1/extract-profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({
        user_id: userId,
        text: `Candidate: ${message}\nCoach: ${reply}`,
        context: "conversation",
      }),
    }).catch(() => {
      // Intentionally ignored — extraction runs best-effort
    });
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(extraction);
  }

  return json({ reply });
});
