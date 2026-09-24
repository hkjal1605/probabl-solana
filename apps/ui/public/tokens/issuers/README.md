# Issuer token logos

Copies of the logos the issuers publish in their mainnet token metadata (the
`image` of each mint's metadata URI, fetched 2026-09-25): xStocks
(`xstocks-metadata.backed.fi`), Ondo Global Markets (`app.ondo.finance`),
PreStocks (`prestocks.com`) and Tessera (`cdn.tesseralab.co`). They are served
locally so the UI makes no third-party image requests.

`packages/shared/src/token-catalog.ts` maps each mainnet token (mint, name,
symbol, description, metadata URI) to its logo here. On Devnet the issuer
replicas take the same identity through `NEXT_PUBLIC_SOLANA_ISSUER_REPLICA_MINTS`
(`SYMBOL=mint,...`, exported by `devnet:verify`). The replicas are test doubles
with a mock issuer authority, never real issuer tokens or claims on the issuers.
