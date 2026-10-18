ALTER TABLE escalator_rule_proposal ADD CONSTRAINT escalator_proposal_candidate_binding UNIQUE(workspace_id,id,candidate_id);
CREATE TABLE escalator_rule_catalog (
 workspace_id text COLLATE "C" NOT NULL REFERENCES escalator_workspace(id),
 id text COLLATE "C" NOT NULL,
 service_id text COLLATE "C" NOT NULL,
 environment_id text COLLATE "C" NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 version_revision bigint NOT NULL CHECK(version_revision BETWEEN 1 AND 9007199254740991),
 generation bigint NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
 status text COLLATE "C" NOT NULL CHECK(status IN ('draft','shadow','active','retired')),
 origin_proposal_id text COLLATE "C",
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,id,version_revision,service_id,environment_id) REFERENCES escalator_rule_version(workspace_id,rule_id,revision,service_id,environment_id),
 FOREIGN KEY(workspace_id,origin_proposal_id,id) REFERENCES escalator_rule_proposal(workspace_id,id,candidate_id),
 CHECK(updated_at>=created_at),
 CHECK(status NOT IN ('shadow','active') OR generation>0),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=32768 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK(data->>'serviceId' IS NOT NULL AND data->>'serviceId'=service_id),
 CHECK(data->>'environmentId' IS NOT NULL AND data->>'environmentId'=environment_id),
 CHECK(data->>'status' IS NOT NULL AND data->>'status'=status),
 CHECK((data->>'revision')::bigint IS NOT NULL AND (data->>'revision')::bigint=revision),
 CHECK((data->>'versionRevision')::bigint IS NOT NULL AND (data->>'versionRevision')::bigint=version_revision),
 CHECK((data->>'generation')::bigint IS NOT NULL AND (data->>'generation')::bigint=generation),
 CHECK(data ? 'originProposalId' AND (data->>'originProposalId') IS NOT DISTINCT FROM origin_proposal_id),
 CHECK((data->>'createdAt')::timestamptz IS NOT NULL AND (data->>'createdAt')::timestamptz=created_at),
 CHECK((data->>'updatedAt')::timestamptz IS NOT NULL AND (data->>'updatedAt')::timestamptz=updated_at)
);
CREATE INDEX escalator_rule_catalog_scope ON escalator_rule_catalog(workspace_id,service_id,environment_id,id);
CREATE TABLE escalator_rule_review (
 workspace_id text COLLATE "C" NOT NULL,
 id text COLLATE "C" NOT NULL,
 rule_id text COLLATE "C" NOT NULL,
 catalog_revision bigint NOT NULL CHECK(catalog_revision BETWEEN 1 AND 9007199254740991),
 version_revision bigint NOT NULL CHECK(version_revision BETWEEN 1 AND 9007199254740991),
 reviewed_by text COLLATE "C" NOT NULL,
 mode text COLLATE "C" NOT NULL CHECK(mode IN ('shadow','active')),
 run_id text COLLATE "C",
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES escalator_rule_catalog(workspace_id,id),
 FOREIGN KEY(workspace_id,rule_id,version_revision) REFERENCES escalator_rule_version(workspace_id,rule_id,revision),
 FOREIGN KEY(workspace_id,reviewed_by) REFERENCES escalator_responder(workspace_id,id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES escalator_rule_backtest(workspace_id,run_id),
 CHECK(mode<>'active' OR run_id IS NOT NULL),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16384 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK(data->>'ruleId' IS NOT NULL AND data->>'ruleId'=rule_id),
 CHECK(data->>'reviewedBy' IS NOT NULL AND data->>'reviewedBy'=reviewed_by),
 CHECK(data->>'mode' IS NOT NULL AND data->>'mode'=mode),
 CHECK((data->>'catalogRevision')::bigint IS NOT NULL AND (data->>'catalogRevision')::bigint=catalog_revision),
 CHECK((data->>'versionRevision')::bigint IS NOT NULL AND (data->>'versionRevision')::bigint=version_revision),
 CHECK(data ? 'runId' AND (data->>'runId') IS NOT DISTINCT FROM run_id),
 CHECK((data->>'createdAt')::timestamptz IS NOT NULL AND (data->>'createdAt')::timestamptz=created_at),
 CHECK((data->>'expiresAt')::timestamptz IS NOT NULL AND (data->>'expiresAt')::timestamptz=expires_at)
);
CREATE INDEX escalator_rule_review_expiry ON escalator_rule_review(workspace_id,rule_id,expires_at,id);
CREATE TABLE escalator_rule_activation (
 workspace_id text COLLATE "C" NOT NULL,
 id text COLLATE "C" NOT NULL,
 rule_id text COLLATE "C" NOT NULL,
 catalog_revision bigint NOT NULL CHECK(catalog_revision BETWEEN 1 AND 9007199254740991),
 version_revision bigint NOT NULL CHECK(version_revision BETWEEN 1 AND 9007199254740991),
 generation bigint NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
 action text COLLATE "C" NOT NULL CHECK(action IN ('drafted','revised','shadowed','activated','retired','rolled_back')),
 actor_id text COLLATE "C" NOT NULL,
 previous_version_revision bigint,
 previous_incident_id text COLLATE "C",
 receipt_id text COLLATE "C",
 recorded_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,rule_id,catalog_revision),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES escalator_rule_catalog(workspace_id,id),
 FOREIGN KEY(workspace_id,rule_id,version_revision) REFERENCES escalator_rule_version(workspace_id,rule_id,revision),
 FOREIGN KEY(workspace_id,rule_id,previous_version_revision) REFERENCES escalator_rule_version(workspace_id,rule_id,revision),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES escalator_responder(workspace_id,id),
 FOREIGN KEY(workspace_id,previous_incident_id) REFERENCES escalator_incident(workspace_id,id),
 FOREIGN KEY(workspace_id,receipt_id) REFERENCES escalator_rule_review(workspace_id,id),
 CHECK((action IN ('shadowed','activated','rolled_back'))=(receipt_id IS NOT NULL)),
 CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=16384 AND NOT(data ? 'workspaceId')),
 CHECK(data->>'id' IS NOT NULL AND data->>'id'=id),
 CHECK(data->>'ruleId' IS NOT NULL AND data->>'ruleId'=rule_id),
 CHECK(data->>'action' IS NOT NULL AND data->>'action'=action),
 CHECK(data->>'actorId' IS NOT NULL AND data->>'actorId'=actor_id),
 CHECK((data->>'catalogRevision')::bigint IS NOT NULL AND (data->>'catalogRevision')::bigint=catalog_revision),
 CHECK((data->>'versionRevision')::bigint IS NOT NULL AND (data->>'versionRevision')::bigint=version_revision),
 CHECK((data->>'generation')::bigint IS NOT NULL AND (data->>'generation')::bigint=generation),
 CHECK(data ? 'previousVersionRevision' AND (data->>'previousVersionRevision')::bigint IS NOT DISTINCT FROM previous_version_revision),
 CHECK(data ? 'previousIncidentId' AND (data->>'previousIncidentId') IS NOT DISTINCT FROM previous_incident_id),
 CHECK(data ? 'receiptId' AND (data->>'receiptId') IS NOT DISTINCT FROM receipt_id),
 CHECK((data->>'recordedAt')::timestamptz IS NOT NULL AND (data->>'recordedAt')::timestamptz=recorded_at)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['escalator_rule_catalog','escalator_rule_review','escalator_rule_activation'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',t||'_scope',t);
 END LOOP;
END; $$;
CREATE FUNCTION escalator_guard_rule_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rules must be retired'; END IF;
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR
    (NEW.data - ARRAY['revision','versionRevision','generation','status','updatedAt']) IS DISTINCT FROM
    (OLD.data - ARRAY['revision','versionRevision','generation','status','updatedAt']) OR
    NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
  RAISE EXCEPTION 'Immutable rule identity or catalog revision conflict';
 END IF;
 IF NEW.status IN ('shadow','active') THEN
  IF NEW.generation<>OLD.generation+1 THEN RAISE EXCEPTION 'Rule activation requires a fresh epoch'; END IF;
 ELSE
  IF NEW.generation<>OLD.generation THEN RAISE EXCEPTION 'Only activation advances the epoch'; END IF;
  IF NEW.status='draft' AND (OLD.status NOT IN ('draft','retired') OR NEW.version_revision<=OLD.version_revision) THEN
   RAISE EXCEPTION 'Only a draft or retired rule can receive a new content revision';
  END IF;
  IF NEW.status='retired' AND NEW.version_revision<>OLD.version_revision THEN
   RAISE EXCEPTION 'Retirement cannot select a different version';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER escalator_rule_catalog_guard BEFORE UPDATE OR DELETE ON escalator_rule_catalog
 FOR EACH ROW EXECUTE FUNCTION escalator_guard_rule_catalog();
CREATE FUNCTION escalator_guard_rule_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND OLD.expires_at<=clock_timestamp() THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Rule reviews are immutable until expiry';
END; $$;
CREATE TRIGGER escalator_rule_review_guard BEFORE UPDATE OR DELETE ON escalator_rule_review
 FOR EACH ROW EXECUTE FUNCTION escalator_guard_rule_review();
CREATE TRIGGER escalator_rule_activation_immutable BEFORE UPDATE OR DELETE ON escalator_rule_activation
 FOR EACH ROW EXECUTE FUNCTION escalator_rule_immutable();
CREATE FUNCTION escalator_check_catalog_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant text; target text; c escalator_rule_catalog%ROWTYPE; r escalator_rule_runtime%ROWTYPE;
BEGIN
 tenant=NEW.workspace_id;
 IF TG_TABLE_NAME='escalator_rule_catalog' THEN target=NEW.id; ELSE target=NEW.rule_id; END IF;
 SELECT * INTO c FROM escalator_rule_catalog WHERE workspace_id=tenant AND id=target;
 -- Legacy explicit runtime fixtures have no catalog; no migration activates them.
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO r FROM escalator_rule_runtime WHERE workspace_id=tenant AND rule_id=target AND retired_at IS NULL;
 IF c.status IN ('active','shadow') THEN
  IF NOT FOUND OR r.generation<>c.generation OR r.rule_revision<>c.version_revision OR r.data->>'mode' IS DISTINCT FROM c.status THEN
   RAISE EXCEPTION 'Rule catalog and runtime activation disagree';
  END IF;
 ELSIF FOUND THEN RAISE EXCEPTION 'Draft or retired catalog cannot retain a live runtime';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER escalator_catalog_runtime_consistency AFTER INSERT OR UPDATE ON escalator_rule_catalog
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION escalator_check_catalog_runtime();
CREATE CONSTRAINT TRIGGER escalator_runtime_catalog_consistency AFTER INSERT OR UPDATE ON escalator_rule_runtime
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION escalator_check_catalog_runtime();
CREATE FUNCTION escalator_check_activation_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r escalator_rule_review%ROWTYPE;
BEGIN
 IF NEW.receipt_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO r FROM escalator_rule_review WHERE workspace_id=NEW.workspace_id AND id=NEW.receipt_id;
 IF NOT FOUND OR r.rule_id<>NEW.rule_id OR r.version_revision<>NEW.version_revision OR
    r.catalog_revision+1<>NEW.catalog_revision OR r.reviewed_by<>NEW.actor_id OR
    r.created_at>clock_timestamp() OR r.expires_at<=clock_timestamp() OR
    (NEW.action='activated' AND r.mode<>'active') OR
    (NEW.action='shadowed' AND r.mode<>'shadow') THEN
  RAISE EXCEPTION 'Rule approval expired or does not match activation';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM escalator_rule_catalog c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.rule_id AND c.revision=NEW.catalog_revision AND c.generation=NEW.generation AND c.status=r.mode) THEN
  RAISE EXCEPTION 'Rule review mode does not match committed activation';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER escalator_activation_review_consistency AFTER INSERT ON escalator_rule_activation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION escalator_check_activation_review();
