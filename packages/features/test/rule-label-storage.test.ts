import { ruleLabelConformance } from "./conformance/rule-labels.js";
import { MemoryRuleLabels } from "./conformance/memory-rule-labels.js";
ruleLabelConformance("memory incident labels", async () => {
  const repository = new MemoryRuleLabels();
  return {
    repository,
    foundation: repository.foundation,
    seedStream: repository.seedStream.bind(repository),
    seedIncident: repository.seedIncident.bind(repository),
    dispose: async () => {},
  };
});
