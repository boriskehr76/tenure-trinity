import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk";
import { MODELS } from "../_shared/models.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const AXES = ["structure", "collaboration", "feedback", "pace", "leadership"] as const;
type Axis = typeof AXES[number];

interface AxisResult {
  baseline: number | null;
  confidence: number;
  contradiction: boolean;
}

type ExtractionResult =
  & { [K in Axis]: AxisResult | null }
  & { profile_summary: string | null };

const SYSTEM_PROMPT =
  `You are extracting structured profile data from text written by or about a UX/UI designer.

Extract axis scores for these 5 dimensions. Each axis runs from 0.0 to 1.0.

Axes:
- structure: 0.0 = thrives in ambiguity, self-directed | 1.0 = needs clear process and brief
- collaboration: 0.0 = deep solo work | 1.0 = co-creative, constant exchange
- feedback: 0.0 = self-directed, internal calibration | 1.0 = needs frequent explicit signals
- pace: 0.0 = deliberate, systematic | 1.0 = fast iteration, comfort with imperfect
- leadership: 0.0 = deep IC craft | 1.0 = growing and directing others

Rules:
1. Only score axes where there is CLEAR EVIDENCE in the text. Return null for axes with no evidence.
2. Weight concrete stories 3x over abstract self-report.
3. Energy signals are strong evidence.
4. Confidence scale: 0.2 = single abstract mention, 0.4 = single concrete story, 0.6 = clear energy signal, 0.8 = repeated pattern.
5. If self-report contradicts story evidence: set baseline null and contradiction true.
6. If the context is "correction", the text is the candidate correcting their own profile in their own words. Treat it as authoritative: confidence 0.9 for the corrected axis.

Output the result inside <scores> tags, exactly like this:
<scores>{
  "structure": { "baseline": number | null, "confidence": number, "contradiction": boolean } | null,
  "collaboration": { "baseline": number | null, "confidence": number, "contradiction": boolean } | null,
  "feedback": { "baseline": number | null, "confidence": number, "contradiction": boolean } | null,
  "pace": { "baseline": number | null, "confidence": number, "contradiction": boolean } | null,
  "leadership": { "baseline": number | null, "confidence": number, "contradiction": boolean } | null,
  "profile_summary": string | null
}</scores>

Nothing outside the <scores> tags.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Internal only — called by conversation / profile functions, never the frontend.
  const internalSecret = Deno.env.get("INTERNAL_SECRET");
  if (!internalSecret || req.headers.get("x-internal-secret") !== internalSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { user_id: string; text: string; context: "cv" | "conversation" | "correction" };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { user_id, text, context } = body;
  if (!user_id || !text || !context) {
    return json({ error: "user_id, text, and context are required" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  let aiMessage;
  try {
    aiMessage = await anthropic.messages.create({
      model: MODELS.default,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Context: ${context}\n\n${text}` }],
    });
  } catch (err) {
    return json({ error: "AI request failed", details: String(err) }, 502);
  }

  const rawContent = aiMessage.content.find((b) => b.type === "text");
  if (!rawContent || rawContent.type !== "text") {
    return json({ error: "Unexpected response type from AI" }, 500);
  }

  const match = rawContent.text.match(/<scores>([\s\S]*?)<\/scores>/);
  if (!match) {
    return json({ error: "No <scores> block in AI response" }, 500);
  }

  let extraction: ExtractionResult;
  try {
    extraction = JSON.parse(match[1]);
  } catch {
    return json({ error: "Failed to parse <scores> content as JSON" }, 500);
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user_id)
    .single();

  const updatedAxes: string[] = [];
  const updates: Record<string, number | string> = {
    profile_last_updated: new Date().toISOString(),
  };

  for (const axis of AXES) {
    const result = extraction[axis];
    if (!result || result.baseline === null || result.confidence < 0.3) continue;

    const observed = Math.max(0, Math.min(1, result.baseline));
    const existingBaseline = existing?.[`axis_${axis}_baseline`] as number | null | undefined;
    const existingMin = existing?.[`axis_${axis}_min`] as number | null | undefined;
    const existingMax = existing?.[`axis_${axis}_max`] as number | null | undefined;
    const existingConfidence = existing?.[`axis_${axis}_confidence`] as number | null | undefined;

    let newBaseline: number;
    if (existingBaseline == null || context === "correction") {
      // First evidence, or an explicit candidate correction — take it directly.
      newBaseline = observed;
    } else {
      newBaseline = existingBaseline * 0.7 + observed * 0.3;
    }

    // Range model: min/max widen as observations accumulate. A contradiction
    // is range data, not a conflict — both ends of the spectrum are real.
    updates[`axis_${axis}_baseline`] = newBaseline;
    updates[`axis_${axis}_min`] = Math.min(existingMin ?? newBaseline, observed, newBaseline);
    updates[`axis_${axis}_max`] = Math.max(existingMax ?? newBaseline, observed, newBaseline);
    updates[`axis_${axis}_confidence`] = Math.min(
      (existingConfidence ?? 0) + result.confidence * 0.3,
      1.0,
    );

    updatedAxes.push(axis);
  }

  if (extraction.profile_summary && context !== "correction") {
    updates["profile_summary"] = extraction.profile_summary;
  }

  if (updatedAxes.length > 0 || extraction.profile_summary) {
    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert({ id: user_id, ...updates }, { onConflict: "id" });

    if (upsertError) {
      return json({ error: "Failed to update profile", details: upsertError.message }, 500);
    }
  }

  return json({ updated_axes: updatedAxes });
});
