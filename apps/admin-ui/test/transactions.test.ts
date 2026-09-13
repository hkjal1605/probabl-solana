import { test,expect } from "bun:test";
import { hashCanonical,normalizeGammaMarket } from "@conditional-stocks/market-data";
import { PublicKey,PROGRAM_ID,coder,unwrap,big,bytes32,key,resolutionHash } from "@conditional-stocks/solana-client";
import { buildCreationEvidence,buildResolutionEvidence,type PayoutVector } from "@conditional-stocks/solana-client/evidence";
import type { AdminPreview,EvidenceView } from "../src/lib/admin-api";
import { evidenceTransaction,verifyAdminPreview } from "../src/lib/transactions";
import { gammaMarket } from "../../../packages/market-data/tests/helpers";
const pubkey=()=>PublicKey.unique().toBase58();
const deployment={rpcUrl:"http://127.0.0.1:8899",programId:PROGRAM_ID.toBase58(),config:pubkey(),genesisHash:pubkey(),marketAdmin:pubkey(),resolutionAdmin:pubkey()};
const source=normalizeGammaMarket(gammaMarket()),market=pubkey();
const creation=()=>buildCreationEvidence({deployment,preparer:deployment.marketAdmin,preparedAt:"2026-09-12T00:00:00Z",attachments:[],
  metadata:source,metadataRawHash:hashCanonical(gammaMarket()),metadataSnapshotId:"fixture",sourceUrls:[source.canonicalUrl],
  config:{baseToken:pubkey(),quoteToken:pubkey(),baseStep:"1",priceTickRawX18:"1000000000000000000",minNotional:"1",
    maxOrderQuantity:"9007199254740993123",maxOrderNotional:"9007199254740993123",maxWalletOpenNotional:"9007199254740993123",
    maxMarketOpenNotional:"18014398509481986246",metadataUri:"ipfs://test",rules:"Example",tradingOpen:"1800000000",tradingCutoff:"1900000000"}});
const resolution=(payout:PayoutVector={yes:"1",no:"0",denominator:"1"})=>buildResolutionEvidence({
  deployment,preparer:deployment.marketAdmin,preparedAt:"2026-09-12T00:00:00Z",attachments:[],conditionId:market,marketId:market,
  metadataRawHash:hashCanonical(gammaMarket()),metadataSnapshotId:"fixture",officialStatus:"resolved",officialUrl:source.canonicalUrl,
  payout,polygon:{chainId:"137",conditionalTokensAddress:"0x1000000000000000000000000000000000000001"},
  polymarketConditionId:source.conditionId,polymarketYesIndex:"1",polymarketNoIndex:"2",
  sourceObservations:[{observedAt:"2026-09-12T00:00:00Z",payout,status:"resolved",url:source.canonicalUrl}],sourceReference:"ipfs://resolution"});
const approved=(envelope:EvidenceView["envelope"]):EvidenceView=>({envelope,status:"approved",reviews:[{decision:"approve",reviewedAt:"2026-09-12T00:00:00Z",reviewer:deployment.marketAdmin}],previews:[],observations:[]});
const preview=(view:EvidenceView,action:AdminPreview["action"]):AdminPreview=>({...evidenceTransaction(view,action,deployment),action,packetHash:view.envelope.packetHash,previewId:"test"});
test("native creation preserves raw u64 amounts beyond JS safe integers",()=>{
  const view=approved(creation()),tx=verifyAdminPreview(view,preview(view,"create-market"),deployment);
  const ix=unwrap(tx)[0]!,decoded=coder.instruction.decode(ix.data)!;
  expect(decoded.name).toBe("create_market");
  expect(big((decoded.data as any).terms.max_quantity)).toBe(9007199254740993123n);
  expect(tx.from).toBe(deployment.marketAdmin);
});
for(const payout of [{yes:"1",no:"0",denominator:"1"},{yes:"0",no:"1",denominator:"1"},{yes:"1",no:"1",denominator:"2"}]as const)
test("resolution commits exact payout "+payout.yes+"/"+payout.no,()=>{
  const value=resolution(payout),view=approved(value),begin=verifyAdminPreview(view,preview(view,"begin-resolution"),deployment),
    resolve=verifyAdminPreview(view,preview(view,"resolve-market"),deployment);
  const decoded=coder.instruction.decode(unwrap(begin)[0]!.data)!;
  expect((decoded.data as any).commitment).toEqual([...resolutionHash(key(deployment.config),key(market),Number(payout.yes),Number(payout.no),bytes32(value.packetHash),value.packet.sourceReference)]);
  expect(begin.from).toBe(deployment.marketAdmin);expect(resolve.from).toBe(deployment.resolutionAdmin);
  expect((coder.instruction.decode(unwrap(resolve)[0]!.data)!.data as any).yes).toBe(Number(payout.yes));
});
test("unsigned review, packet tampering, EVM packets and cross-deployment execution fail closed",()=>{
  const view=approved(creation());
  for(const status of ["prepared","rejected"]as const)expect(()=>evidenceTransaction({...view,status},"create-market",deployment)).toThrow("approval");
  expect(()=>evidenceTransaction({...view,reviews:[]},"create-market",deployment)).toThrow("approval");
  view.envelope.packet.preparer=pubkey();expect(()=>evidenceTransaction(view,"create-market",deployment)).toThrow("packet hash");
  const good=approved(creation());
  for(const field of ["config","genesisHash","programId"]as const)expect(()=>evidenceTransaction(good,"create-market",{...deployment,[field]:pubkey()})).toThrow("deployment");
  expect(()=>evidenceTransaction(good,"resolve-market",deployment)).toThrow("Action");
});
test("preview cannot change authority, payload, market, payment or evidence",()=>{
  const view=approved(resolution()),expected=preview(view,"resolve-market");
  for(const changes of [{from:pubkey()},{to:pubkey()},{expectedMarketId:pubkey()},{data:"bad"},{packetHash:"bad"},{value:"1"}])
    expect(()=>verifyAdminPreview(view,{...expected,...changes}as AdminPreview,deployment)).toThrow("differs");
  const altered=resolution({yes:"1",no:"1",denominator:"2"});(altered.packet.payout as any).denominator="1";altered.packetHash=hashCanonical(altered.packet);
  expect(()=>evidenceTransaction(approved(altered),"resolve-market",deployment)).toThrow("payout");
});
