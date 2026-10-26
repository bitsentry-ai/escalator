import type { PagingChannel } from "../../contracts/index.js";
/** Email is translated, ntfy keeps its lowercase name, and other channel names are capitalized. */
export function channelLabel(
  channel: PagingChannel,
  t: (key: string) => string,
): string {
  if (channel === "email") return t("settings.emailChannel");
  if (channel === "ntfy") return channel;
  return channel[0].toUpperCase() + channel.slice(1);
}
