import { Logger, logLevel } from "@conditional-stocks/shared";

export const logger = new Logger({ service: "api", level: logLevel(process.env.LOG_LEVEL) });
