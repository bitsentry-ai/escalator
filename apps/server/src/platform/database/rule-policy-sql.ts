/** Closed SQL with bound scope, stream kind/id, service/environment and cutoff.
 * Each CTE is an indexed latest-fact lookup, not a scan of the tenant's history.
 */
export const rulePolicySql = `WITH
 stream AS (SELECT * FROM escalator_rule_policy_fact WHERE workspace_id=$1 AND kind=$2 AND entity_id=$3
   AND recorded_at<=$6::timestamptz ORDER BY recorded_at DESC,id DESC LIMIT 1),
 service AS (SELECT * FROM escalator_rule_policy_fact WHERE workspace_id=$1 AND kind='service' AND entity_id=$4
   AND recorded_at<=$6::timestamptz ORDER BY recorded_at DESC,id DESC LIMIT 1),
 binding AS (SELECT * FROM escalator_rule_policy_fact WHERE workspace_id=$1 AND kind='binding' AND service_id=$4 AND environment_id=$5
   AND recorded_at<=$6::timestamptz ORDER BY recorded_at DESC,id DESC LIMIT 1),
 source AS (SELECT * FROM escalator_rule_policy_fact WHERE workspace_id=$1 AND kind='signal'
   AND entity_id=(SELECT CASE WHEN $2='signal' THEN entity_id ELSE source_id END FROM stream)
   AND recorded_at<=$6::timestamptz ORDER BY recorded_at DESC,id DESC LIMIT 1),
 policy AS (SELECT * FROM escalator_rule_policy_fact WHERE workspace_id=$1 AND kind='policy'
   AND entity_id=(SELECT policy_id FROM binding)
   AND recorded_at<=$6::timestamptz ORDER BY recorded_at DESC,id DESC LIMIT 1),
 picked AS (SELECT * FROM stream UNION SELECT * FROM service UNION SELECT * FROM binding UNION SELECT * FROM source UNION SELECT * FROM policy)
 SELECT jsonb_build_object('workspaceId',$1::text,'id',id::text,'kind',kind,'entityId',entity_id,
   'serviceId',service_id,'environmentId',environment_id,'sourceId',source_id,'policyId',policy_id,
   'enabled',enabled,'deleted',deleted,
   'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS fact
 FROM picked ORDER BY id`;
