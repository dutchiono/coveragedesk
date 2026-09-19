#!/usr/bin/env bash
set -Eeuo pipefail

# Deployment script for CoverageDesk on coveragedesk.online

echo "=== Registering site coveragedesk with add-site.sh ==="
/srv/drink/bin/add-site.sh coveragedesk coveragedesk.online https://github.com/dutchiono/coveragedesk.git main "npm run build" dist

echo "=== Setting up Python environment ==="
cd /srv/drink/apps/coveragedesk/backend
python3 -m venv .venv || true
.venv/bin/pip install -r requirements.txt

echo "=== Installing systemd service ==="
sudo cp /srv/drink/apps/coveragedesk/docs/coveragedesk-api.service /etc/systemd/system/coveragedesk-api.service
sudo systemctl daemon-reload
sudo systemctl enable coveragedesk-api
sudo systemctl restart coveragedesk-api

echo "=== CoverageDesk Deployment Ready ==="
echo "Site root: /srv/drink/www/coveragedesk.online/current"
echo "Backend API: 127.0.0.1:8800"
