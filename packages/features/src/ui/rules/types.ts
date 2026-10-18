import type { RulesClient } from "./client.js";
export type RuleText = (key: string) => string;
export interface RulesScope {
  serviceId: string;
  environmentId: string;
}
export interface RulesProps {
  client: RulesClient;
  scope: RulesScope;
  t: RuleText;
}
