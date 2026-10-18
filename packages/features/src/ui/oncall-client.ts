import type {
  Schedule,
  SchedulePreview,
  Service,
  Responder,
  ConfigurationPageInput,
  WriteScheduleInput,
  PreviewScheduleInput,
} from "../contracts/index.js";
export interface OnCallPage<T> {
  items: T[];
  next: string | null;
}
export type ScheduleCoverage = Pick<
  SchedulePreview,
  "scheduleId" | "scheduleVersion" | "startsAt" | "endsAt" | "intervals"
>;
/** Authenticated host transport supplies scope; UI never resolves channel secrets. */
export interface OnCallClient {
  schedules(input: ConfigurationPageInput): Promise<OnCallPage<Schedule>>;
  schedule(input: { id: string }): Promise<Schedule>;
  writeSchedule(input: WriteScheduleInput): Promise<Schedule>;
  coverage(input: PreviewScheduleInput): Promise<ScheduleCoverage>;
  preview(input: PreviewScheduleInput): Promise<SchedulePreview>;
  services(input: ConfigurationPageInput): Promise<OnCallPage<Service>>;
  responders(input: ConfigurationPageInput): Promise<OnCallPage<Responder>>;
}
