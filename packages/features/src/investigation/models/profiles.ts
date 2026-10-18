import type { ModelProfile } from "../../contracts/model-profile.js";
export {
  modelProfileSchema,
  type ModelProfile,
} from "../../contracts/model-profile.js";
import type { ModelScope, OperationContext } from "../ports/index.js";
export interface ModelProfileReader {
  /** Host is bound to trusted work authorization. Validate the live claim and
   * service/environment profile binding on EVERY read, including secretless local models.
   * Return null for disabled, missing, unauthorized or no-longer-bound profiles.
   */
  load(
    scope: ModelScope,
    id: string,
    context: OperationContext,
  ): Promise<ModelProfile | null>;
}
