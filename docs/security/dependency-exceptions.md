# Dependency audit exceptions

## GHSA-7grf-83vw-6f5x — accepted transitive, unreachable component

`@gnosis.pm/conditional-tokens-contracts@1.0.3` pins `openzeppelin-solidity@2.3.0`, so package audits report the moderate `ERC165Checker` unbounded-gas advisory.

The deployed Gnosis Conditional Tokens source imports `ERC165`, `IERC165`, `SafeMath`, `Address`, and `IERC20`; it does not import or call `ERC165Checker`. The affected component is therefore absent from the pinned Conditional Tokens creation/runtime bytecode used by this protocol. Replacing the transitive package would change the selected CTF build and is not a safe mechanical dependency update.

CI ignores only `GHSA-7grf-83vw-6f5x` and continues to fail on every other audit finding. Re-evaluate this exception when changing the CTF artifact, during independent audit, and before production deployment. Confirm the import graph and deployed-bytecode hash again rather than relying on this note alone.
