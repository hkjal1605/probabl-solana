import { Logger, logLevel } from "@conditional-stocks/shared";

export const logger = new Logger({
  service: "admin-ui",
  level: logLevel(process.env.NEXT_PUBLIC_LOG_LEVEL),
});
