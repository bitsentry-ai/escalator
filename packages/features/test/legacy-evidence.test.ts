import test from "node:test";
import assert from "node:assert/strict";
import { buildLegacyEvidenceVerificationPrompt } from "../src/investigation/evidence/legacy-prompt.js";
import { truncateLegacyEvidenceText } from "../src/investigation/evidence/legacy-values.js";
import { buildLegacyEvidenceQuery } from "../src/investigation/evidence/legacy-queries.js";
import {
  getWazuhHttpFacts,
  HTTP_EVIDENCE_GUIDANCE,
} from "../src/investigation/evidence/wazuh-http-facts.js";
import type {
  LegacyDiagnosisEvidenceRequest,
  LegacyDiagnosisEvidenceCollection,
} from "../src/investigation/evidence/legacy-types.js";
const request: LegacyDiagnosisEvidenceRequest = {
  entryId: 91,
  entryIndex: "entry-1",
  ruleId: "5710",
  ruleDescription: "Unknown user or bad password",
  ruleLevel: 10,
  ruleGroups: ["authentication"],
  category: "security",
  entrySource: {},
  entryTimestamp: new Date("2026-04-06T15:00:00Z"),
  agentName: "dc-01",
  agentIp: "10.0.0.15",
  diagnosisText: "Likely brute-force activity.",
};
const evidence: LegacyDiagnosisEvidenceCollection = {
  sourceType: "wazuh",
  sourceId: "source",
  sourceName: "SIEM",
  providerObject: {},
  queries: [
    {
      sourceType: "wazuh",
      query: 'rule.id:"5710"',
      resultCount: 2,
      hasMore: false,
      output: "Two related events.",
    },
  ],
  toolsUsed: ["source_query:wazuh"],
};
function bundle(providerObject: Record<string, unknown>) {
  const prompt = buildLegacyEvidenceVerificationPrompt({
    request,
    evidence: { ...evidence, providerObject },
  });
  return JSON.parse(prompt.split("SOURCE EVIDENCE BUNDLE:\n")[1]);
}

test("legacy evidence prompt preserves the original sections, timestamp and source query", () => {
  const prompt = buildLegacyEvidenceVerificationPrompt({ request, evidence });
  assert.match(
    prompt,
    /^You are a cybersecurity verification agent using source evidence only\./,
  );
  assert.ok(prompt.includes(HTTP_EVIDENCE_GUIDANCE));
  assert.ok(
    prompt.includes(
      "Do not claim live server inspection, MCP tool use, OS inspection, registry checks, SSH access, or direct host access.",
    ),
  );
  assert.ok(
    prompt.includes("VERDICT: <VERIFIED|PARTIALLY_VERIFIED|NOT_VERIFIED>"),
  );
  assert.ok(
    prompt.includes("PREVIOUS AI DIAGNOSIS:\nLikely brute-force activity."),
  );
  assert.deepEqual(bundle({}), {
    verificationMethod: "source_evidence",
    source: { type: "wazuh", id: "source", name: "SIEM" },
    originalEntry: {
      entryId: 91,
      entryIndex: "entry-1",
      ruleId: "5710",
      ruleDescription: "Unknown user or bad password",
      ruleLevel: 10,
      ruleGroups: ["authentication"],
      category: "security",
      timestamp: "2026-04-06T15:00:00.000Z",
      agentName: "dc-01",
      agentIp: "10.0.0.15",
    },
    originalProviderObject: {},
    evidenceQueries: evidence.queries,
  });
});

test("legacy compaction retains existing volume limits and omitted payload fields", () => {
  const value = bundle({
    headers: { authorization: "omitted-with-headers" },
    request_body: "omitted-body",
    message: "x".repeat(700),
    array: [0, 1, 2, 3, 4, 5],
    nested: { one: { two: { retainedOnlyAsMarker: true } } },
  }).originalProviderObject;
  assert.equal(value.headers, undefined);
  assert.equal(value.request_body, undefined);
  assert.equal(value.message, truncateLegacyEvidenceText("x".repeat(700), 500));
  assert.deepEqual(value.array, [0, 1, 2, 3, 4]);
  assert.equal(value.nested.one.two, "[object]");
  const many = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => ["key" + index, index]),
  );
  assert.equal(Object.keys(bundle(many).originalProviderObject).length, 24);
});

test("decoded HTTP facts survive the generic object-entry cap", () => {
  const provider = {
    ...Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => ["key" + index, index]),
    ),
    decoder: { name: "web-accesslog" },
    data: { id: "503", protocol: "POST", url: "/health", srcip: "192.0.2.1" },
  };
  const result = bundle(provider);
  assert.equal(result.originalProviderObject.decoder, undefined);
  assert.deepEqual(result.originalEntry.httpFacts, {
    httpStatus: 503,
    method: "POST",
    url: "/health",
    sourceIp: "192.0.2.1",
  });
});

test("Wazuh hit/source wrappers preserve decoded facts and string-only semantics", () => {
  const source = {
    decoder: { name: "web-accesslog" },
    data: {
      id: "500",
      protocol: " GET ",
      url: "x".repeat(3000),
      srcip: "192.0.2.2",
    },
  };
  for (const input of [
    source,
    { _source: source },
    { hit: { _source: source } },
  ]) {
    const facts = getWazuhHttpFacts(input);
    assert.equal(facts?.httpStatus, 500);
    assert.equal(facts?.method, " GET ");
    assert.equal(facts?.url?.length, 2048);
    assert.equal(facts?.sourceIp, "192.0.2.2");
  }
  assert.equal(
    getWazuhHttpFacts({ ...source, data: { id: 500 } })?.httpStatus,
    undefined,
  );
  assert.equal(
    getWazuhHttpFacts({ ...source, data: { id: "500 " } })?.httpStatus,
    undefined,
  );
  assert.equal(
    getWazuhHttpFacts({ ...source, decoder: { name: "other" } }),
    undefined,
  );
  assert.equal(getWazuhHttpFacts([]), undefined);
});

test("legacy prompt diagnosis and final bundle retain their character budgets", () => {
  const prompt = buildLegacyEvidenceVerificationPrompt({
    request: { ...request, diagnosisText: "d".repeat(2000) },
    evidence: {
      ...evidence,
      queries: [{ ...evidence.queries[0], output: "x".repeat(15000) }],
    },
  });
  const diagnosis = prompt
    .split("PREVIOUS AI DIAGNOSIS:\n")[1]
    .split("\n\nSOURCE EVIDENCE BUNDLE:")[0];
  const finalBundle = prompt.split("SOURCE EVIDENCE BUNDLE:\n")[1];
  assert.equal(diagnosis, truncateLegacyEvidenceText("d".repeat(2000), 1200));
  assert.ok(finalBundle.length <= 10000);
  assert.ok(finalBundle.endsWith("...[truncated]"));
});

test("Wazuh query normalization preserves its window, event precedence and escaping", () => {
  const query = buildLegacyEvidenceQuery("wazuh", request, {
    _source: {
      agent: { name: 'event"agent', ip: "10.1.2.3" },
      rule: { id: 550 },
      data: { srcip: "192.0.2.4" },
    },
  });
  assert.ok(
    query.startsWith(
      "@timestamp:[2026-04-06T14:45:00.000Z TO 2026-04-06T15:15:00.000Z]",
    ),
  );
  assert.ok(query.includes('agent.name:"event\\"agent"'));
  assert.ok(query.includes('agent.ip:"10.1.2.3"'));
  assert.ok(query.includes('rule.id:"550"'));
  for (const field of [
    "data.srcip",
    "data.src_ip",
    "win.eventdata.ipAddress",
    "win.eventdata.sourceNetworkAddress",
  ])
    assert.ok(query.includes(field + ':"192.0.2.4"'));
  assert.equal(query.includes("dc-01"), false);
});

test("provider query selectors retain their existing issue/fingerprint/title priorities", () => {
  assert.equal(
    buildLegacyEvidenceQuery("sentry", request, { shortId: " APP-42 " }),
    "issue:APP-42",
  );
  assert.equal(
    buildLegacyEvidenceQuery(
      "sentry",
      { ...request, ruleId: undefined },
      { externalIssueId: 0 },
    ),
    "0",
  );
  assert.equal(
    buildLegacyEvidenceQuery("posthog", request, {
      externalIssueId: "project:fingerprint:extra",
    }),
    "fingerprint:extra",
  );
  assert.equal(
    buildLegacyEvidenceQuery("posthog", request, {
      fingerprint: "first",
      externalIssueId: "project:second",
    }),
    "first",
  );
  assert.equal(
    buildLegacyEvidenceQuery("github", request, { title: ' Fix "request" ' }),
    'is:issue "Fix request"',
  );
  assert.equal(
    buildLegacyEvidenceQuery(
      "github",
      { ...request, ruleId: undefined, ruleDescription: "" },
      {},
    ),
    "is:issue",
  );
});
