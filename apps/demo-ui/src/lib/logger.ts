import { Logger, logLevel } from "@conditional-stocks/shared";

export const logger = new Logger({
  service: "web",
  level: logLevel(process.env.NEXT_PUBLIC_LOG_LEVEL),
});
