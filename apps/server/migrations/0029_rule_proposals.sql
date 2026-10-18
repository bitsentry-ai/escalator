CREATE TABLE escalator_rule_proposal (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 source_snapshot_id text COLLATE "C" NOT NULL,
 source_input_hash text COLLATE "C" NOT NULL,
 origin_label_id text COLLATE "C" NOT NULL,
 requested_by text COLLATE "C" NOT NULL,
 candidate_id text COLLATE "C" NOT NULL,
 profile_id text COLLATE "C" NOT NULL,
 profile_revision bigint NOT NULL CHECK(profile_revision BETWEEN 1 AND 9007199254740991),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 status text COLLATE "C" NOT NULL CHECK(status IN ('queued','generating','evaluating','ready','failed','cancelled')),
 runtime_id text COLLATE "C",
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,source_snapshot_id),
 UNIQUE(workspace_id,candidate_id),
 FOREIGN KEY(workspace_id,source_snapshot_id,source_input_hash) REFERENCES escalator_rule_replay_snapshot(workspace_id,id,input_hash),
 FOREIGN KEY(workspace_id,origin_label_id) REFERENCES escalator_incident_label(workspace_id,id),
 FOREIGN KEY(workspace_id,requested_by) REFERENCES escalator_responder(workspace_id,id),
 FOREIGN KEY(workspace_id,profile_id) REFERENCES escalator_investigation_settings(workspace_id,id),
 CHECK(updated_at >= created_at AND expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
 CHECK((status='generating')=(runtime_id IS NOT NULL)),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=65536 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK(data->>'sourceSnapshotId' IS NOT NULL AND data->>'sourceSnapshotId'=source_snapshot_id),
 CHECK(data->>'sourceInputHash' IS NOT NULL AND data->>'sourceInputHash'=source_input_hash),
 CHECK(data->>'originLabelId' IS NOT NULL AND data->>'originLabelId'=origin_label_id),
 CHECK(data->>'requestedBy' IS NOT NULL AND data->>'requestedBy'=requested_by),
 CHECK(data->>'candidateId' IS NOT NULL AND data->>'candidateId'=candidate_id),
 CHECK(data->>'profileId' IS NOT NULL AND data->>'profileId'=profile_id),
 CHECK((data->>'profileRevision')::bigint IS NOT NULL AND (data->>'profileRevision')::bigint=profile_revision),
 CHECK((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK(data->>'status' IS NOT NULL AND data->>'status'=status),
 CHECK((data->>'createdAt')::timestamptz IS NOT NULL AND (data->>'createdAt')::timestamptz=created_at),
 CHECK((data->>'updatedAt')::timestamptz IS NOT NULL AND (data->>'updatedAt')::timestamptz=updated_at),
 CHECK((data->>'expiresAt')::timestamptz IS NOT NULL AND (data->>'expiresAt')::timestamptz=expires_at)
);
CREATE INDEX escalator_rule_proposal_pending ON escalator_rule_proposal(workspace_id,status,created_at,id);
CREATE FUNCTION escalator_rule_proposal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status NOT IN ('ready','failed','cancelled') THEN RAISE EXCEPTION 'Pending proposal cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR
    (NEW.data - ARRAY['revision','status','generation','failure','fullRunId','heldOutRunId','updatedAt']) IS DISTINCT FROM
    (OLD.data - ARRAY['revision','status','generation','failure','fullRunId','heldOutRunId','updatedAt']) OR
    NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
   RAISE EXCEPTION 'immutable proposal identity or revision conflict';
 END IF;
 IF (OLD.status='queued' AND NEW.status NOT IN ('generating','failed','cancelled')) OR
    (OLD.status='generating' AND NEW.status NOT IN ('generating','evaluating','failed','cancelled')) OR
    (OLD.status='evaluating' AND NEW.status NOT IN ('evaluating','ready','failed','cancelled')) OR
    OLD.status IN ('ready','failed','cancelled') THEN
   RAISE EXCEPTION 'invalid proposal transition';
 END IF;
 IF (OLD.data->'generation' IS DISTINCT FROM 'null'::jsonb AND NEW.data->'generation' IS DISTINCT FROM OLD.data->'generation') OR
    (OLD.data->>'fullRunId' IS NOT NULL AND NEW.data->>'fullRunId' IS DISTINCT FROM OLD.data->>'fullRunId') OR
    (OLD.data->>'heldOutRunId' IS NOT NULL AND NEW.data->>'heldOutRunId' IS DISTINCT FROM OLD.data->>'heldOutRunId') THEN
   RAISE EXCEPTION 'immutable proposal result';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER escalator_rule_proposal_transition BEFORE UPDATE OR DELETE ON escalator_rule_proposal
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_proposal_transition();
ALTER TABLE escalator_rule_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalator_rule_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY escalator_rule_proposal_scope ON escalator_rule_proposal
 USING(workspace_id=current_setting('app.workspace_id',true))
 WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
