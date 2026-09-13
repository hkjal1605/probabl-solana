#!/usr/bin/env bash
# Run as ubuntu on the dedicated EC2 host after configuring Cloudflare DNS.
# No Cloudflare token, application environment, or deployer key is needed here.
set -euo pipefail
umask 077
cd /home/ubuntu/probabl-solana
if [[ "${1:-}" != "" && "${1:-}" != "--issue-only" ]]; then
  echo "Usage: setup-https.sh [--issue-only]" >&2
  exit 1
fi
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends certbot
sudo -n install -d -m 0755 /var/www/probabl-sol-acme \
  /var/www/probabl-sol-acme/.well-known /var/www/probabl-sol-acme/.well-known/acme-challenge
sudo -n install -m 0644 ops/ec2/solana/acme-readiness.txt /var/www/probabl-sol-acme/.well-known/acme-challenge/probabl-readiness
sudo -n install -d -m 0700 /etc/probabl-sol-backups
sudo -n install -m 0644 ops/ec2/solana/nginx-http.conf /etc/nginx/conf.d/probabl-sol-http.conf

probabl_resolved=$(getent ahostsv4 api-solana.probabl.trade | awk '{print $1}' | sort -u)
if [[ "$probabl_resolved" != "57.183.26.209" ]]; then
  echo "DNS is not yet pointing exclusively to this EC2 instance; retry after propagation." >&2
  exit 1
fi

if ! sudo -n test -s /etc/letsencrypt/live/api-solana.probabl.trade/fullchain.pem; then
  sudo -n install -m 0644 ops/ec2/solana/acme-bootstrap.conf /etc/nginx/sites-available/probabl-sol-acme
  if [[ ! -e /etc/nginx/sites-enabled/probabl-sol-acme ]]; then
    sudo -n ln -s /etc/nginx/sites-available/probabl-sol-acme /etc/nginx/sites-enabled/probabl-sol-acme
  fi
  sudo -n nginx -t
  sudo -n systemctl reload nginx
  curl --fail --silent --show-error --max-time 5 --retry 5 --retry-all-errors --retry-delay 1 --retry-max-time 20 \
    --resolve api-solana.probabl.trade:80:127.0.0.1 \
    http://api-solana.probabl.trade/.well-known/acme-challenge/probabl-readiness
  sudo -n certbot certonly --webroot --webroot-path /var/www/probabl-sol-acme \
    --domain api-solana.probabl.trade --cert-name api-solana.probabl.trade \
    --non-interactive --agree-tos --register-unsafely-without-email --no-eff-email --key-type ecdsa
fi
sudo -n openssl x509 -in /etc/letsencrypt/live/api-solana.probabl.trade/fullchain.pem \
  -noout -checkhost api-solana.probabl.trade
sudo -n install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo -n install -m 0755 ops/ec2/certbot-renew-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/probabl-sol-nginx
sudo -n systemctl enable --now certbot.timer
if [[ "${1:-}" == "--issue-only" ]]; then
  echo "Certificate and renewal are configured; now run setup-supervision.sh for a new host."
  exit 0
fi

if [[ ! -e /etc/probabl-sol-backups/nginx-before-https.conf ]]; then
  sudo -n cp -a /etc/nginx/sites-available/probabl-sol /etc/probabl-sol-backups/nginx-before-https.conf
fi
# Preserve the currently installed config on each run so failed validation is recoverable.
sudo -n cp -a /etc/nginx/sites-available/probabl-sol /etc/probabl-sol-backups/nginx-before-https-latest.conf
sudo -n install -m 0644 ops/ec2/solana/nginx.conf /etc/nginx/sites-available/probabl-sol
if [[ -L /etc/nginx/sites-enabled/probabl-sol-acme ]]; then
  sudo -n mv /etc/nginx/sites-enabled/probabl-sol-acme /etc/probabl-sol-backups/nginx-acme-site-link
fi
if ! sudo -n nginx -t; then
  sudo -n cp -a /etc/probabl-sol-backups/nginx-before-https-latest.conf /etc/nginx/sites-available/probabl-sol
  echo "HTTPS validation failed; previous Nginx config restored without reloading." >&2
  exit 1
fi
sudo -n systemctl reload nginx
curl --fail --silent --show-error --max-time 10 --retry 3 --retry-all-errors --retry-delay 1 --retry-max-time 30 \
  --resolve api-solana.probabl.trade:443:127.0.0.1 https://api-solana.probabl.trade/ready
systemctl is-active nginx certbot.timer
sudo -n certbot certificates
