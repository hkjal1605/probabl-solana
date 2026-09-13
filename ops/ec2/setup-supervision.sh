#!/usr/bin/env bash
# Install reviewed service/logging configuration on the dedicated Ubuntu host.
set -euo pipefail
umask 077
cd /home/ubuntu/probabl

# The ingress template now requires the domain's existing Certbot certificate.
# Refuse before changing supervision if HTTPS has not been provisioned yet.
sudo -n test -s /etc/letsencrypt/live/api.probabl.trade/fullchain.pem
sudo -n test -s /etc/letsencrypt/live/api.probabl.trade/privkey.pem

pm2 install pm2-logrotate@3.0.0
# pmx auto-casts "true" to boolean, but upstream 3.0.0 accepts only strings.
# Preserve the tiny compatibility patch so compression survives reinstalls.
probabl_rotate_root=/home/ubuntu/.pm2/modules/pm2-logrotate/node_modules/pm2-logrotate
if git -C "$probabl_rotate_root" apply --reverse --check /home/ubuntu/probabl/ops/ec2/pm2-logrotate.patch 2>/dev/null; then
  echo "pm2-logrotate boolean compatibility patch already applied"
else
  git -C "$probabl_rotate_root" apply --check /home/ubuntu/probabl/ops/ec2/pm2-logrotate.patch
  git -C "$probabl_rotate_root" apply /home/ubuntu/probabl/ops/ec2/pm2-logrotate.patch
fi
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:workerInterval 10
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:rotateModule true
pm2 set pm2-logrotate:TZ UTC
chmod 700 /home/ubuntu/.pm2

sudo -n install -d -m 0700 /etc/probabl-backups
if [[ ! -e /etc/probabl-backups/nginx.logrotate.initial ]]; then
  sudo -n cp -a /etc/logrotate.d/nginx /etc/probabl-backups/nginx.logrotate.initial
fi
if [[ ! -e /etc/probabl-backups/rsyslog.logrotate.initial ]]; then
  sudo -n cp -a /etc/logrotate.d/rsyslog /etc/probabl-backups/rsyslog.logrotate.initial
fi
sudo -n install -d -m 0755 /etc/systemd/system/logrotate.timer.d /etc/systemd/journald.conf.d
sudo -n install -m 0644 ops/ec2/nginx.logrotate /etc/logrotate.d/nginx
sudo -n install -m 0644 ops/ec2/rsyslog.logrotate /etc/logrotate.d/rsyslog
# pm2-logrotate also owns pm2.log/agent.log. Do not double-rotate those with logrotate.
sudo -n install -m 0644 ops/ec2/logrotate-timer.conf /etc/systemd/system/logrotate.timer.d/probabl.conf
sudo -n install -m 0644 ops/ec2/journald.conf /etc/systemd/journald.conf.d/probabl.conf

sudo -n env PATH=/usr/local/bin:/usr/bin:/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo -n install -d -m 0755 /etc/systemd/system/pm2-ubuntu.service.d
sudo -n install -m 0644 ops/ec2/pm2-systemd.conf /etc/systemd/system/pm2-ubuntu.service.d/probabl.conf
sudo -n systemctl daemon-reload
sudo -n systemctl restart systemd-journald
sudo -n systemctl restart logrotate.timer
sudo -n logrotate --debug /etc/logrotate.conf

# Activate systemd supervision before application startup, so the memory/task
# limits apply to the daemon and every application from their first launch.
pm2 save
pm2 kill
sudo -n systemctl start pm2-ubuntu
sudo -n systemctl enable pm2-ubuntu nginx logrotate.timer

sudo -n install -m 0644 ops/ec2/nginx.conf /etc/nginx/sites-available/probabl
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  sudo -n mv /etc/nginx/sites-enabled/default /etc/probabl-backups/nginx-default-site-link
fi
if [[ ! -e /etc/nginx/sites-enabled/probabl ]]; then
  sudo -n ln -s /etc/nginx/sites-available/probabl /etc/nginx/sites-enabled/probabl
fi
sudo -n nginx -t
sudo -n systemctl reload nginx
systemctl is-active pm2-ubuntu nginx logrotate.timer
systemctl show pm2-ubuntu -p User -p MemoryHigh -p MemoryMax -p TasksMax -p LimitNOFILE -p LimitCORE -p UMask
