import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

  const userId = user.id;
  const url = new URL(req.url);
  // Path segments after the function name, e.g. ["", "abc-123"] or ["", "abc-123", "stage"]
  const segments = url.pathname.split("/").filter(Boolean);
  // segments[0] is the function name ("applications"), segments[1] is the id, segments[2] is sub-route
  const id = segments[1] ?? null;
  const subRoute = segments[2] ?? null;

  // GET /
  if (req.method === "GET" && !id) {
    const { data, error } = await supabase
      .from("applications")
      .select("*")
      .eq("user_id", userId)
      .neq("status_flag", "deleted")
      .order("created_at", { ascending: false });

    if (error) return json({ error: error.message }, 500);
    return json({ applications: data });
  }

  // POST /
  if (req.method === "POST" && !id) {
    let body: { company_name: string; role_title: string; channel: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { company_name, role_title, channel } = body;
    if (!company_name || !role_title || !channel) {
      return json({ error: "company_name, role_title, and channel are required" }, 400);
    }

    const { data, error } = await supabase
      .from("applications")
      .insert({ user_id: userId, company_name, role_title, channel })
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ application: data }, 201);
  }

  // PATCH /:id/stage
  if (req.method === "PATCH" && id && subRoute === "stage") {
    let body: { stage: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.stage) {
      return json({ error: "stage is required" }, 400);
    }

    const { data, error } = await supabase
      .from("applications")
      .update({ current_stage: body.stage })
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "Application not found" }, 404);
    return json({ application: data });
  }

  // PATCH /:id
  if (req.method === "PATCH" && id && !subRoute) {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Prevent overriding ownership
    delete body["user_id"];
    delete body["id"];

    const { data, error } = await supabase
      .from("applications")
      .update(body)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "Application not found" }, 404);
    return json({ application: data });
  }

  // DELETE /:id
  if (req.method === "DELETE" && id) {
    const { data, error } = await supabase
      .from("applications")
      .update({ status_flag: "deleted" })
      .eq("id", id)
      .eq("user_id", userId)
      .select("id")
      .single();

    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "Application not found" }, 404);
    return json({ success: true });
  }

  return json({ error: "Not found" }, 404);
});
