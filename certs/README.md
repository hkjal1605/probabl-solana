# RDS public trust bundle

`rds-ap-northeast-1-bundle.pem` contains the three public RDS root CA certificates
for Asia Pacific (Tokyo). Downloaded on 2026-09-13 from the
[official AWS RDS truststore](https://truststore.pki.rds.amazonaws.com/ap-northeast-1/ap-northeast-1-bundle.pem),
linked in the [Aurora TLS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.SSL.html).
This file contains public certificates only, not private keys.

The Devnet `DATABASE_URL` uses `sslmode=verify-full` and an absolute `sslrootcert`
path to this bundle so both certificate trust and server hostname are verified.
The region-specific bundle is appropriate for this Tokyo cluster; the snippet's
global bundle is not required. Copy the bundle to EC2 and adjust that path there.
Do not replace this with `rejectUnauthorized: false` or disable TLS verification.

Review AWS's certificate-rotation guidance when maintaining or updating the bundle.
