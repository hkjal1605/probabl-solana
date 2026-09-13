-- Stop the old services before applying. Never erase a pending broadcast or intent.
-- Historical migrations are retained; this retires only obsolete operational tables.
LOCK TABLE matching.proposals, settlement.batches, settlement.ioc_intents, gateway.operations IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM matching.proposals WHERE status IN ('persisted','submitted','mined'))
    OR EXISTS (SELECT 1 FROM settlement.batches WHERE status IN ('queued','simulated','submitted','mined'))
    OR EXISTS (SELECT 1 FROM settlement.ioc_intents WHERE status = 'waiting-match')
    OR EXISTS (SELECT 1 FROM gateway.operations WHERE kind = 'order' AND state NOT IN ('canonical','failed'))
  THEN
    RAISE EXCEPTION 'Pending legacy orders exist: reconcile or archive the old development database before atomic migration';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TABLE settlement.attempts;
--> statement-breakpoint
DROP TABLE settlement.batch_books;
--> statement-breakpoint
DROP TABLE settlement.batches;
--> statement-breakpoint
DROP TABLE settlement.ioc_intents;
--> statement-breakpoint
DROP TABLE matching.checkpoints;
--> statement-breakpoint
DROP TABLE matching.decisions;
--> statement-breakpoint
DROP TABLE matching.events;
--> statement-breakpoint
DROP TABLE matching.leases;
--> statement-breakpoint
DROP TABLE matching.proposals;
--> statement-breakpoint
DROP SCHEMA matching;
--> statement-breakpoint
DROP SCHEMA settlement;
