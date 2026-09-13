#!/bin/sh
# Certbot deploy hook: reload nginx only after a successfully renewed certificate.
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
