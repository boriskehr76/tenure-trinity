import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk";
import { selectModel } from "../_shared/models.ts";

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

function extractJson(text: string): unknown {
  let s = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = s.search(/[\{\[]/);
  const open = s[start];
  const end = s.lastIndexOf(open === "[" ? "]" : "}");
  if (start === -1 || end === -1) throw new Error("No JSON found in response");
  s = s.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(s);
}

const SYSTEM_PROMPT =
  `You are an honest career advisor helping UX/UI designers evaluate job opportunities. You have no incentive to encourage applications — only to give accurate assessments. Analyse the job description and return ONLY a valid JSON object with these exact fields:
{
  company_name: string,
  role_title: string,
  summary: string (2-3 sentences of what this role actually is),
  match_pct: number (0-100, honest — not flattering),
  key_requirements: string[] (3-5 real requirements),
  interview_questions: string[] (exactly 2 questions to probe what the JD does not say),
  honest_flag: string (one thing the JD hints at but does not say directly)
}
Return only the JSON. No preamble. No markdown. Respond with a single JSON object only. No markdown. No code fences. No commentary before or after the JSON.`;

interface Analysis {
  company_name: string;
  role_title: string;
  summary: string;
  match_pct: number;
  key_requirements: string[];
  interview_questions: string[];
  honest_flag: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Validate JWT
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

  // Parse body
  let body: { job_url?: string; job_text?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { job_url, job_text } = body;
  let jobDescriptionText = job_text ?? "";

  // Fetch page if URL provided
  if (job_url) {
    try {
      const pageRes = await fetch(job_url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; JobAnalyser/1.0)" },
      });
      const raw = await pageRes.text();
      const stripped = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

      if (stripped.length < 200) {
        return json({
          error: "linkedin_blocked",
          message: "LinkedIn blocks direct access — paste the job description text instead",
        }, 422);
      }

      jobDescriptionText = stripped;
    } catch {
      return json({
        error: "linkedin_blocked",
        message: "LinkedIn blocks direct access — paste the job description text instead",
      }, 422);
    }
  }

  if (!jobDescriptionText) {
    return json({ error: "Provide either job_url or job_text" }, 400);
  }

  // Call Claude
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  let message;
  try {
    message = await anthropic.messages.create({
      model: selectModel("job_analysis"),
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: jobDescriptionText }],
    });
  } catch (err) {
    return json({ error: "AI request failed", details: String(err) }, 502);
  }

  const rawContent = message.content[0];
  if (rawContent.type !== "text") {
    return json({ error: "Unexpected response type from AI" }, 500);
  }

  let analysis: Analysis;
  try {
    analysis = extractJson(rawContent.text) as Analysis;
  } catch {
    return json({ error: "Failed to parse AI response as JSON" }, 500);
  }

  // Persist to DB
  const { data: application, error: insertError } = await supabase
    .from("applications")
    .insert({
      user_id: user.id,
      company_name: analysis.company_name,
      role_title: analysis.role_title,
      job_url: job_url ?? null,
      job_description_text: jobDescriptionText,
      match_pct: analysis.match_pct,
      analysis_summary: analysis.summary,
      analysis_requirements: JSON.stringify(analysis.key_requirements),
      analysis_interview_questions: JSON.stringify(analysis.interview_questions),
      analysis_honest_flag: analysis.honest_flag,
    })
    .select("id")
    .single();

  if (insertError) {
    return json({ error: "Failed to save application", details: insertError.message }, 500);
  }

  return json({
    application_id: application.id,
    analysis: {
      company_name: analysis.company_name,
      role_title: analysis.role_title,
      summary: analysis.summary,
      match_pct: analysis.match_pct,
      key_requirements: analysis.key_requirements,
      interview_questions: analysis.interview_questions,
      honest_flag: analysis.honest_flag,
    },
  }, 201);
});
