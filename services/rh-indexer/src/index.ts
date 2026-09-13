import "./handlers/authority.ts";
import "./handlers/block.ts";
import "./handlers/exchange.ts";
import "./handlers/lifecycle.ts";
import "./handlers/registry.ts";
import "./handlers/tokens.ts";
import "./handlers/payouts.ts";
import { logger } from "./logger.ts";

logger.info("indexer.handlers.registered", { protocolVersion: 2 });
