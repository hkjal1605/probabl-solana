#!/usr/bin/env bash
# Dedicated Ubuntu devnet host, run as ubuntu AFTER DB provisioning.
set -euo pipefail
umask 077
cd /home/ubuntu/probabl-solana
# The ingress now requires the certificate issued through acme-bootstrap.conf.
# Refuse before restarting any service if first-time TLS provisioning is incomplete.
sudo -n test -s /etc/letsencrypt/live/api-solana.probabl.trade/fullchain.pem
sudo -n test -s /etc/letsencrypt/live/api-solana.probabl.trade/privkey.pem
for probabl_service in api indexer polymarket; do
  test -s ".local/ec2/env/$probabl_service.env"
done

pm2 install pm2-logrotate@3.0.0
probabl_rotate_root=/home/ubuntu/.pm2/modules/pm2-logrotate/node_modules/pm2-logrotate
if ! git -C "$probabl_rotate_root" apply --reverse --check "$PWD/ops/ec2/pm2-logrotate.patch" 2>/dev/null; then
  git -C "$probabl_rotate_root" apply --check "$PWD/ops/ec2/pm2-logrotate.patch"
  git -C "$probabl_rotate_root" apply "$PWD/ops/ec2/pm2-logrotate.patch"
fi
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:workerInterval 10
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:rotateModule true
pm2 set pm2-logrotate:TZ UTC
chmod 700 /home/ubuntu/.pm2

sudo -n install -d -m 0700 /etc/probabl-sol-backups
if [[ ! -e /etc/probabl-sol-backups/nginx.logrotate.initial ]]; then
  sudo -n cp -a /etc/logrotate.d/nginx /etc/probabl-sol-backups/nginx.logrotate.initial
fi
sudo -n install -m 0644 ops/ec2/nginx.logrotate /etc/logrotate.d/nginx
sudo -n install -d -m 0755 /etc/systemd/system/logrotate.timer.d /etc/systemd/journald.conf.d
sudo -n install -m 0644 ops/ec2/logrotate-timer.conf /etc/systemd/system/logrotate.timer.d/probabl-sol.conf
sudo -n install -m 0644 ops/ec2/journald.conf /etc/systemd/journald.conf.d/probabl-sol.conf
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo -n install -d -m 0755 /etc/systemd/system/pm2-ubuntu.service.d
sudo -n install -m 0644 ops/ec2/solana/pm2-systemd.conf /etc/systemd/system/pm2-ubuntu.service.d/probabl-sol.conf
sudo -n systemctl daemon-reload
sudo -n systemctl restart systemd-journald logrotate.timer
sudo -n logrotate --debug /etc/logrotate.conf

# Restart the initially empty PM2 daemon under systemd resource limits.
pm2 save
pm2 kill
sudo -n systemctl start pm2-ubuntu
sudo -n systemctl enable pm2-ubuntu nginx logrotate.timer
pm2 start ops/ec2/solana/ecosystem.config.cjs
pm2 save

sudo -n install -m 0644 ops/ec2/solana/nginx-http.conf /etc/nginx/conf.d/probabl-sol-http.conf
sudo -n install -m 0644 ops/ec2/solana/nginx.conf /etc/nginx/sites-available/probabl-sol
if [[ -L /etc/nginx/sites-enabled/probabl-sol-acme ]]; then
  sudo -n mv /etc/nginx/sites-enabled/probabl-sol-acme /etc/probabl-sol-backups/nginx-acme-site-link
fi
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  sudo -n mv /etc/nginx/sites-enabled/default /etc/probabl-sol-backups/nginx-default-site-link
fi
if [[ ! -e /etc/nginx/sites-enabled/probabl-sol ]]; then
  sudo -n ln -s /etc/nginx/sites-available/probabl-sol /etc/nginx/sites-enabled/probabl-sol
fi
sudo -n nginx -t
sudo -n systemctl reload nginx
systemctl is-active pm2-ubuntu nginx logrotate.timer
