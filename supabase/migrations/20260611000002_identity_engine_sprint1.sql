-- Identity Engine Sprint 1 additions.
--
-- Per-axis confidence: drives the extraction merge weighting and tells the
-- frontend which axes have enough evidence to draw (partial diagram with
-- named gaps vs. full diagram).
--
-- validated_at: set when the candidate confirms "yes, this feels accurate"
-- on the full diagram (PRD flow 2 — profile locks with confirmation).

alter table profiles
  add column axis_structure_confidence double precision default 0,
  add column axis_collaboration_confidence double precision default 0,
  add column axis_feedback_confidence double precision default 0,
  add column axis_pace_confidence double precision default 0,
  add column axis_leadership_confidence double precision default 0,
  add column validated_at timestamptz;

-- The conversation function reads history per user (and per job) ordered by time.
create index conversations_user_created_idx
  on conversations (user_id, created_at);

create index applications_user_idx
  on applications (user_id);
