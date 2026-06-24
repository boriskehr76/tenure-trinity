
# Tenure — Claude Code Context
**Last updated: June 2026**

---

## What this project is

Tenure is a career coaching platform for UX/UI designers in Sweden. It builds a verified professional identity profile through conversation — not forms, not personality tests. The profile lives across a designer's full career.

Current phase: Stage 0.9 (Job Tracker) → Stage 1.0 (Identity Engine / coaching agent).

---
## Three-layer architecture — never cross these boundaries

```
Layer 1  Lovable          Frontend UI only. Auth calls to Supabase only.
                          NEVER calls Claude API directly.
                          NEVER queries Supabase tables directly (except auth).

Layer 2  Edge Functions   ALL business logic. ALL Claude API calls.
                          Validates JWT on every request.
                          Only layer that holds ANTHROPIC_API_KEY.

Layer 3  Supabase         Postgres + RLS + Auth. Stores everything permanently.
                          RLS policy on every table: user_id = auth.uid()
                          No exceptions.
```

If you are about to write code that calls Claude from the frontend — stop. Route it through an Edge Function.

---

## Supabase project

```
Project ref:   fvrdluiodycckqdufbqj
Region:        eu-north-1
Edge base URL: https://fvrdluiodycckqdufbqj.supabase.co/functions/v1
Key names:     publishable (not "anon") / secret (not "service_role")
```

---

## Edge Functions — what exists

All five are deployed and curl-tested.

```
supabase/functions/
  analyse-job/        Fetches job URL, calls Claude, returns structured analysis,
                      auto-creates application card. Uses: default model.

  conversation/       Profile coaching agent. Session memory from Supabase.
                      Dual call: reply + silent extract-profile after each turn.
                      Uses: conversation_complex model (see model router below).

  extract-profile/    Internal only — called by conversation after each turn.
                      Writes axis min/baseline/max + confidence to profiles.
                      Fire and forget (handed to EdgeRuntime.waitUntil — plain
                      fire-and-forget fetch gets killed when the response returns).
                      Deployed with verify_jwt=false (set in config.toml) —
                      it authenticates via x-internal-secret, not a user JWT.
                      Uses: default model.

  profile/            GET /profile (axis scores + completeness),
                      PATCH /profile/axis/:name (correction mechanism),
                      POST /profile/validate (candidate confirms the profile read).
                      Uses: no direct AI calls (text corrections route through
                      extract-profile with context "correction").

  applications/       CRUD for job tracker cards + stage moves.
                      Stage moves write to stage_history.
                      Uses: no AI calls.

  stats/              Aggregates response rates, channel breakdown, stagnation flags.
                      Uses: no AI calls.

  _shared/
    models.ts         Model router. Single source of truth for all model strings.
```

---

## Model router — _shared/models.ts

```typescript
// CURRENT routing — updated June 2026
const MODELS = {
  conversation_complex: "claude-opus-4-8",  // coaching agent — Opus 4.8 for reasoning depth.
                                             // Was claude-fable-5; Fable/Mythos access is
                                             // currently suspended (export control directive).
                                             // Opus 4.8 is the direct replacement for this slot.
  default: "claude-sonnet-4-6",             // all other AI calls
};

// FORCE_MODEL env var overrides both — use for testing all functions on Haiku
// export FORCE_MODEL=claude-haiku-4-5-20251001
```

Do not hardcode model strings anywhere else. Always import from `_shared/models.ts`.

---

## Opus 4.8 prompting rules — conversation Edge Function only

These apply specifically to the `conversation` Edge Function system prompt.
All other functions use standard Sonnet prompting.

**1. Pass system prompt as cached prefix**
```typescript
system: [
  {
    type: "text",
    text: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },  // 90% input token discount on repeated calls
  }
]
```

**2. Set effort level**
```typescript
// In the API call body:
effort: "high"
// Opus 4.8 defaults effort to "high" automatically across the Claude API and
// Claude Code — this explicit setting is now optional, but keep it for clarity
// and so a future default change doesn't silently alter behavior here.
// Not xhigh — that's for long-horizon agentic runs, not conversations.
// Not medium — coaching requires real reasoning depth.
```

**3. System prompt structure — use XML tags**
```
<role>...</role>
<goal>...</goal>           ← state what done looks like, not just what to do
<axes>...</axes>
<conversation_method>...</conversation_method>
<output_format>...</output_format>
<response_style>...</response_style>
```

**4. Structured output via XML tags**
```
Model outputs: <scores>{"structure":0.0,"collaboration":0.0,...}</scores>
Extract with: raw.match(/<scores>([\s\S]*?)<\/scores>/)
NOT: embedded JSON regex hunting
```

**5. Anti-overplanning guard — include in every Opus 4.8 system prompt**
```
When you have enough information to act, act. Do not re-derive facts already
established in the conversation, re-litigate decisions already made, or narrate
options you will not pursue in user-facing messages.
```

**6. Brevity instruction — include in every Opus 4.8 system prompt**
```
Lead with the outcome. 2–3 sentences. Cut narration of reasoning and options
not pursued. Do not survey choices — make a recommendation.
```

---

## Database schema — key tables

```sql
profiles          id, email, name, availability_state,
                  axis_structure_min/baseline/max,
                  axis_collaboration_min/baseline/max,
                  axis_feedback_min/baseline/max,
                  axis_pace_min/baseline/max,
                  axis_leadership_min/baseline/max,
                  profile_summary, profile_last_updated

applications      id, user_id, company, role, stage, channel,
                  job_url, why_interested, notes,
                  created_at, updated_at

stage_history     id, application_id, from_stage, to_stage, timestamp
                  — written on every card move, never deleted

conversations     id, user_id, job_id (nullable), role, content,
                  input_mode, created_at
```

RLS on all tables. Policy: `user_id = auth.uid()`. No exceptions.

Store axis scores as min/baseline/max from day one, **and display the full band (min–max), not baseline only — this is the v1.0 model, not deferred to v2.0.** The spider/radar visualization is deprecated (see Current build gates below); the replacement is a narrative "how I see you" header plus five horizontal spectrum rows, each showing the band with confidence rendered as solid (strong evidence) vs faint/hollow (thin evidence) — `confidence` is already in the `/profile` response shape for exactly this.

---

## Kanban stages

```
considering → applied → interview → offer_closed
```

Stage moves write to `stage_history`. The `stats` function reads this for channel breakdown and stagnation detection.

---

## Environment variables

**Edge Functions (secret — never in frontend):**
```
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
FORCE_MODEL                    (optional — overrides model router for testing)
```

**Frontend / Lovable (public — safe to expose):**
```
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY  (was ANON_KEY in legacy naming)
```

---

## API contract — what Lovable calls

```
POST   /functions/v1/applications          create card
PATCH  /functions/v1/applications/:id      update card fields
PATCH  /functions/v1/applications/:id/stage  move stage
GET    /functions/v1/applications          get all cards for user
GET    /functions/v1/stats                 channel breakdown + stagnation
POST   /functions/v1/analyse-job           analyse a job URL
POST   /functions/v1/conversation          send message, get reply
GET    /functions/v1/profile               get axis scores + summary + completeness
PATCH  /functions/v1/profile/axis/:name    correct a single axis (text and/or value)
POST   /functions/v1/profile/validate      candidate confirms "this feels accurate"
```

Every request: `Authorization: Bearer <supabase-jwt>`

---

## Deploy commands

```bash
# Deploy a single function
supabase functions deploy conversation --project-ref fvrdluiodycckqdufbqj

# Deploy all functions
supabase functions deploy --project-ref fvrdluiodycckqdufbqj

# Set a secret
supabase secrets set ANTHROPIC_API_KEY=... --project-ref fvrdluiodycckqdufbqj

# Test locally with curl
curl -i --location --request POST \
  'http://localhost:54321/functions/v1/conversation' \
  --header 'Authorization: Bearer <local-anon-key>' \
  --header 'Content-Type: application/json' \
  --data '{"message":"Tell me about a project you are proud of","job_id":null}'
```

---

## Current build gates

**Gate to ship v0.9 (tracker):**
- 30 active users with 3+ cards each
- 20 users active in last 14 days
- stage_history writing correctly on every move
- stats panel pulling accurate numbers

**Gate to ship v1.0 (Identity Engine):**
- All v0.9 gates cleared
- 5 real manual coaching sessions completed
- 4 of 5 sprint-1 users say the profile read (narrative + spectrum rows) reflects something true their CV doesn't — unprompted

---

## What NOT to do

- Do not call Claude from Lovable / frontend components
- Do not query Supabase tables directly from Lovable (except auth)
- Do not hardcode model strings — use `_shared/models.ts`
- Do not skip RLS on new tables
- Do not store axis scores without min/baseline/max columns
- Do not use xhigh effort on the conversation function — use high
- Do not use embedded JSON regex for score extraction — use XML tags
- Do not build a spider/radar chart for the profile visualization — deprecated, it implies "edge of the chart = better" which contradicts the no-judgment model. Use the narrative header + five horizontal spectrum rows instead.
- Do not reference `claude-fable-5` or any Mythos-tier model in code or prompts while access remains suspended

---

## Locked in specs, not yet in this schema (next backend task)

The Tenure Trinity model adds a Coach surface (Pro tier, SEK 149/month, plus one free scoped session per user) and a tier/entitlement system. None of it exists in the schema above yet. When picking this up:

- `profiles` needs: `tier` (`free`/`pro`), `tier_source` (`none`/`comp`/`paid`), `tier_granted_at`, `tier_expires_at`, `cv_storage_path`, `cv_uploaded_at`, `level1_questions_answered`
- A new `coach_sessions` table, with a unique index on `(user_id) where session_kind = 'free_intro'` so the one-time free session is enforced at the database level, not just in application code
- A new `/coach` Edge Function, gated server-side on `tier` plus `coach_sessions` state — never gated in Lovable

**Before writing this migration, reconcile naming against the live schema, don't assume it matches any spec doc.** The Architecture Spec circulating for this project uses `company_name`/`role_title` and a 6-stage kanban (`researching/applied/first_contact/interviewing/final_round/closed`) — the real `applications` table above uses `company`/`role` and a 4-stage kanban (`considering/applied/interview/offer_closed`). That doc was written without checking this file. Trust this file, the live schema, not the spec doc, for field names. Flag the mismatch back rather than silently picking one.

