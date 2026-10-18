import {
  MaintenanceAdmission,
  type RetentionRuntimeResources,
} from "@bitsentry-escalator/features/application";
export function retentionFixture(): RetentionRuntimeResources {
  return {
    admission: new MaintenanceAdmission(),
    repository: {
      read: async () => {
        throw new Error("Unexpected maintenance read");
      },
      transaction: async () => {
        throw new Error("Unexpected maintenance transaction");
      },
    },
  };
}
