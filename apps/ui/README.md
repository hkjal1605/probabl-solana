# Main UI wallet sessions

The main UI remembers the selected Solana wallet and address in browser localStorage with no scheduled expiry. On refresh, Phantom and Solflare reconnect only if the site is already trusted. Unknown injected wallets are restored only when already connected. Locked wallets, revoked permissions, or cleared browser storage may require a manual reconnect. No signature popup is opened automatically.

After an explicit sign-in, the API-issued bearer token is reusable for an absolute four hours (or a shorter server expiry). Refreshing does not extend that deadline. Restoration requires the same origin, wallet address, Solana genesis hash, program, and config, plus successful RPC network verification. The original signed message, signature, and private key are not stored.

Disconnect clears the remembered wallet and session. Account changes, cross-tab logout, expiry, and an API 401 clear authentication and cached wallet data. Expiry keeps the wallet connected. Requests check expiry and the connected wallet immediately before sending a bearer token, including in background tabs. Transaction instructions are still compared byte-for-byte before broadcast.

These are browser-side reuse limits, not server-side revocation: the API currently issues eight-hour tokens. localStorage is readable by JavaScript on the same origin; it is not an HttpOnly cookie. If browser storage is blocked, the current connection works in memory and the wallet dialog shows a persistence warning.

Run `bun test test` and `bun run typecheck --incremental false` from this directory. Browser review: connect and sign in once, refresh, verify no additional signature is needed, then disconnect and refresh to confirm it remains disconnected.
