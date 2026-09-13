import { Logger, logLevel } from "@conditional-stocks/shared";

export const logger = new Logger({ service: "rh-indexer", level: logLevel(process.env.LOG_LEVEL) });
