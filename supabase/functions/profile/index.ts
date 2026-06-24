import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PATCH, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const AXES = ["structure", "collaboration", "feedback", "pace", "leadership"] as const;
type Axis = typeof AXES[number];

// An axis is drawable once confidence crosses this threshold. Below it, the
// frontend shows the axis as a named gap ("come back to complete").
const DRAWABLE_CONFIDENCE = 0.3;

function shapeProfile(profile: Record<string, unknown>) {
  const axes: Record<string, unknown> = {};
  let drawable = 0;

  for (const axis of AXES) {
    const baseline = profile[`axis_${axis}_baseline`] as number | null;
    const confidence = (profile[`axis_${axis}_confidence`] as number | null) ?? 0;
    const hasData = baseline != null && confidence >= DRAWABLE_CONFIDENCE;
    if (hasData) drawable++;
    axes[axis] = {
      min: profile[`axis_${axis}_min`],
      baseline,
      max: profile[`axis_${axis}_max`],
      confidence,
      has_data: hasData,
    };
  }

  return {
    name: profile.name,
    email: profile.email,
    availability_state: profile.availability_state,
    axes,
    axes_with_data: drawable,
    profile_complete: drawable === AXES.length,
    profile_summary: profile.profile_summary,
    profile_last_updated: profile.profile_last_updated,
    validated_at: profile.validated_at,
  };
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

  // Path after the function name: "" | "axis/:name" | "validate"
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const profileIdx = segments.indexOf("profile");
  const subPath = segments.slice(profileIdx + 1);

  // GET /profile — axis scores + summary + completeness
  if (req.method === "GET" && subPath.length === 0) {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return json({ error: "Profile not found" }, 404);
    }

    return json(shapeProfile(profile));
  }

  // POST /profile/validate — candidate confirms "yes, this feels accurate"
  if (req.method === "POST" && subPath[0] === "validate") {
    const { error } = await supabase
      .from("profiles")
      .update({ validated_at: new Date().toISOString() })
      .eq("id", userId);

    if (error) {
      return json({ error: "Failed to validate profile", details: error.message }, 500);
    }

    return json({ validated: true });
  }

  // PATCH /profile/axis/:name — candidate flags an axis and corrects it
  if (req.method === "PATCH" && subPath[0] === "axis" && subPath[1]) {
    const axis = subPath[1] as Axis;
    if (!AXES.includes(axis)) {
      return json({ error: `Unknown axis: ${axis}` }, 400);
    }

    let body: { correction: string; value?: number };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { correction, value } = body;
    if (!correction || typeof correction !== "string") {
      return json({ error: "correction text is required" }, 400);
    }

    // The correction enters the conversation history so the agent
    // acknowledges it naturally in the next session.
    const { error: insertError } = await supabase.from("conversations").insert({
      user_id: userId,
      job_id: null,
      role: "user",
      content: `[Correction to ${axis} axis] ${correction}`,
      input_mode: "correction",
    });

    if (insertError) {
      return json({ error: "Failed to record correction", details: insertError.message }, 500);
    }

    // A correction invalidates any prior validation.
    const directUpdates: Record<string, number | null> = { validated_at: null } as Record<
      string,
      number | null
    >;

    if (typeof value === "number" && value >= 0 && value <= 1) {
      // Candidate set the value directly — authoritative. The range collapses
      // to the corrected point and rebuilds as new evidence accumulates.
      directUpdates[`axis_${axis}_baseline`] = value;
      directUpdates[`axis_${axis}_min`] = value;
      directUpdates[`axis_${axis}_max`] = value;
      directUpdates[`axis_${axis}_confidence`] = 0.9;

      const { error } = await supabase
        .from("profiles")
        .update({ ...directUpdates, profile_last_updated: new Date().toISOString() })
        .eq("id", userId);

      if (error) {
        return json({ error: "Failed to update axis", details: error.message }, 500);
      }
    } else {
      // Text-only correction — run it through extraction (context: correction
      // gives it authoritative confidence). Await so the response reflects
      // the updated profile.
      await supabase.from("profiles").update(directUpdates).eq("id", userId);

      const internalSecret = Deno.env.get("INTERNAL_SECRET");
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      if (internalSecret && supabaseUrl) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/extract-profile`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": internalSecret,
            },
            body: JSON.stringify({
              user_id: userId,
              text: `The candidate is correcting the "${axis}" axis of their profile: ${correction}`,
              context: "correction",
            }),
          });
        } catch {
          // Correction text is already saved; extraction can re-run later.
        }
      }
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    return json({ corrected: axis, profile: profile ? shapeProfile(profile) : null });
  }

  return json({ error: "Not found" }, 404);
});
