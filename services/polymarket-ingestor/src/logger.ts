import { Logger, logLevel } from "@conditional-stocks/shared";

export const logger = new Logger({
  service: "polymarket-ingestor",
  level: logLevel(process.env.LOG_LEVEL),
});
