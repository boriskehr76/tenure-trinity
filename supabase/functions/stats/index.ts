import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function daysBetween(a: string | Date, b: string | Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
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

  // Fetch all non-deleted applications for this user
  const { data: applications, error: appsError } = await supabase
    .from("applications")
    .select("id, company_name, role_title, current_stage, status_flag, channel, applied_at, last_activity_at, created_at")
    .eq("user_id", userId)
    .neq("status_flag", "deleted");

  if (appsError) return json({ error: appsError.message }, 500);
  const apps = applications ?? [];

  // Fetch all stage_history rows for this user's applications
  const appIds = apps.map((a) => a.id);
  let stageHistory: { application_id: string; to_stage: string; moved_at: string }[] = [];

  if (appIds.length > 0) {
    const { data: historyData, error: historyError } = await supabase
      .from("stage_history")
      .select("application_id, to_stage, moved_at")
      .in("application_id", appIds);

    if (historyError) return json({ error: historyError.message }, 500);
    stageHistory = historyData ?? [];
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. active_count
  const activeApps = apps.filter((a) => a.current_stage !== "closed");
  const active_count = activeApps.length;

  // 2. response_rate
  const appliedApps = apps.filter((a) => a.applied_at != null);
  const firstContactHistory = stageHistory.filter((h) => h.to_stage === "first_contact");
  const firstContactAppIds = new Set(firstContactHistory.map((h) => h.application_id));

  const appliedWithResponse = appliedApps.filter((a) => firstContactAppIds.has(a.id));
  const response_rate = appliedApps.length > 0
    ? Math.round((appliedWithResponse.length / appliedApps.length) * 1000) / 10
    : 0;

  // 3. avg_days_to_response
  const daysToResponseList: number[] = [];
  for (const app of appliedApps) {
    if (!app.applied_at) continue;
    const contactEvents = firstContactHistory
      .filter((h) => h.application_id === app.id)
      .sort((a, b) => new Date(a.moved_at).getTime() - new Date(b.moved_at).getTime());
    if (contactEvents.length === 0) continue;
    daysToResponseList.push(daysBetween(app.applied_at, contactEvents[0].moved_at));
  }

  const avg_days_to_response = daysToResponseList.length > 0
    ? Math.round(daysToResponseList.reduce((s, d) => s + d, 0) / daysToResponseList.length * 10) / 10
    : null;

  // 4. channel_breakdown
  const channelMap = new Map<string, { total: number; responded: number }>();
  for (const app of apps) {
    const channel = app.channel ?? "unknown";
    if (!channelMap.has(channel)) channelMap.set(channel, { total: 0, responded: 0 });
    const entry = channelMap.get(channel)!;
    entry.total += 1;
    if (app.applied_at && firstContactAppIds.has(app.id)) entry.responded += 1;
  }

  const channel_breakdown = [...channelMap.entries()]
    .filter(([, v]) => v.total >= 2)
    .map(([channel, v]) => ({
      channel,
      count: v.total,
      response_rate: v.total > 0
        ? Math.round((v.responded / v.total) * 1000) / 10
        : 0,
    }));

  // 5. longest_stalled
  let longest_stalled: { company_name: string; role_title: string; days: number } | null = null;
  for (const app of activeApps) {
    if (!app.last_activity_at) continue;
    const days = daysBetween(app.last_activity_at, now);
    if (!longest_stalled || days > longest_stalled.days) {
      longest_stalled = { company_name: app.company_name, role_title: app.role_title, days };
    }
  }

  // 6. added_this_week
  const added_this_week = apps.filter(
    (a) => new Date(a.created_at) >= sevenDaysAgo,
  ).length;

  return json({
    stats: {
      active_count,
      response_rate,
      avg_days_to_response,
      channel_breakdown,
      longest_stalled,
      added_this_week,
    },
  });
});
