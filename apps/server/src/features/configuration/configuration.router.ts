import {
  configurationPageSchema,
  configurationIdSchema,
  writeScheduleSchema,
  writePolicySchema,
  writeContactSchema,
  writeAvailabilitySchema,
  previewScheduleInputSchema,
} from "@bitsentry-escalator/features/contracts";
import { t } from "../../platform/trpc/context.js";
import { authenticated } from "../../platform/trpc/authenticated.js";
export const configurationRouter = t.router({
  coverage: authenticated
    .input(previewScheduleInputSchema)
    .query(({ ctx, input }) => ctx.configuration.coverage(ctx.actor, input)),
  schedules: authenticated
    .input(configurationPageSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.list(ctx.actor, "schedules", input),
    ),
  schedule: authenticated
    .input(configurationIdSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.get(ctx.actor, "schedules", input),
    ),
  writeSchedule: authenticated
    .input(writeScheduleSchema)
    .mutation(({ ctx, input }) =>
      ctx.configuration.writeSchedule(ctx.actor, input),
    ),
  policies: authenticated
    .input(configurationPageSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.list(ctx.actor, "policies", input),
    ),
  policy: authenticated
    .input(configurationIdSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.get(ctx.actor, "policies", input),
    ),
  writePolicy: authenticated
    .input(writePolicySchema)
    .mutation(({ ctx, input }) =>
      ctx.configuration.writePolicy(ctx.actor, input),
    ),
  contacts: authenticated
    .input(configurationPageSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.list(ctx.actor, "contacts", input),
    ),
  writeContact: authenticated
    .input(writeContactSchema)
    .mutation(({ ctx, input }) =>
      ctx.configuration.writeContact(ctx.actor, input),
    ),
  availability: authenticated
    .input(configurationPageSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.list(ctx.actor, "availability", input),
    ),
  writeAvailability: authenticated
    .input(writeAvailabilitySchema)
    .mutation(({ ctx, input }) =>
      ctx.configuration.writeAvailability(ctx.actor, input),
    ),
  preview: authenticated
    .input(previewScheduleInputSchema)
    .mutation(({ ctx, input }) => ctx.configuration.preview(ctx.actor, input)),
  storedPreview: authenticated
    .input(configurationIdSchema)
    .query(({ ctx, input }) =>
      ctx.configuration.get(ctx.actor, "previews", input),
    ),
  responders: authenticated
    .input(configurationPageSchema)
    .query(({ ctx, input }) => ctx.configuration.responders(ctx.actor, input)),
});
