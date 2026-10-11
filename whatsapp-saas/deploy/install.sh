#!/usr/bin/env bash
# WA Business Desk — Ubuntu/Debian VPS এ এক কমান্ডে ইনস্টল/আপডেট
#
#   curl -fsSL https://raw.githubusercontent.com/mhsiddiqui96/index.html/main/whatsapp-saas/deploy/install.sh | sudo bash
#
# আবার চালালে কোড আপডেট হয়ে অ্যাপ নতুন করে চালু হবে; ডাটা ও .env অক্ষত থাকবে।
set -euo pipefail

REPO="${REPO:-https://github.com/mhsiddiqui96/index.html.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/wa-desk}"
APP_DIR="$INSTALL_DIR/whatsapp-saas"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }
# Read from the terminal even when this script is piped through `curl | bash`.
ask()  { local prompt="$1" default="${2:-}" reply; read -r -p "$prompt" reply < /dev/tty || true; echo "${reply:-$default}"; }

[ "$(id -u)" -eq 0 ] || die "root হিসেবে চালান: sudo bash install.sh"
command -v apt-get >/dev/null || die "এই স্ক্রিপ্ট Ubuntu/Debian সার্ভারের জন্য।"

say "প্রয়োজনীয় প্যাকেজ ইনস্টল হচ্ছে"
apt-get update -qq
apt-get install -y -qq git curl openssl ca-certificates >/dev/null

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Docker ইনস্টল হচ্ছে"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

say "কোড ডাউনলোড হচ্ছে ($BRANCH)"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch -q origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -q "$BRANCH"
  git -C "$INSTALL_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" --depth 1 "$REPO" "$INSTALL_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  say "প্রথমবার সেটআপ — কয়েকটি তথ্য দিন"
  SERVER_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org || echo 'আপনার-সার্ভার-IP')"
  echo "আপনার ডোমেইনের (বা সাবডোমেইনের) DNS A রেকর্ড এই সার্ভারের IP তে দিন: $SERVER_IP"
  DOMAIN="$(ask 'ডোমেইন (যেমন desk.example.com): ')"
  [ -n "$DOMAIN" ] || die "ডোমেইন ছাড়া HTTPS চালু করা যাবে না।"
  APP_SECRET="$(ask 'Meta App Secret (এখন না থাকলে Enter চাপুন, পরে .env এ দিতে পারবেন): ')"
  SIGNUP="$(ask 'অন্য বিজনেসও নিজে সাইন-আপ করতে পারবে (SaaS মোড)? [y/N]: ' n)"
  case "$SIGNUP" in [yY]*) ALLOW_SIGNUP=true ;; *) ALLOW_SIGNUP=false ;; esac
  VERIFY_TOKEN="$(openssl rand -hex 16)"
  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
SECRET_KEY=$(openssl rand -hex 32)
WEBHOOK_VERIFY_TOKEN=$VERIFY_TOKEN
META_APP_SECRET=$APP_SECRET
GRAPH_API_VERSION=v21.0
ALLOW_SIGNUP=$ALLOW_SIGNUP
COOKIE_SECURE=true
EOF
  umask 022
else
  say ".env আগে থেকেই আছে — আগের সেটিংস রাখা হলো"
fi

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
VERIFY_TOKEN="$(grep -E '^WEBHOOK_VERIFY_TOKEN=' .env | cut -d= -f2-)"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "ফায়ারওয়ালে 80/443 পোর্ট খোলা হচ্ছে"
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
fi

say "অ্যাপ বিল্ড ও চালু হচ্ছে (প্রথমবার কয়েক মিনিট লাগতে পারে)"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

say "অ্যাপ চালু হওয়ার অপেক্ষা"
for _ in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
[ "${OK:-}" = 1 ] || { docker compose logs --tail 50 app; die "অ্যাপ চালু হয়নি — উপরের লগ দেখুন।"; }

cat <<EOF

✅ ইনস্টল সম্পন্ন!

  অ্যাপ:            https://$DOMAIN
                    (প্রথমবার HTTPS সার্টিফিকেট তৈরিতে ১-২ মিনিট লাগতে পারে)

  Meta Webhook সেটআপ (developers.facebook.com → আপনার App → WhatsApp → Configuration):
    Callback URL:   https://$DOMAIN/webhook
    Verify Token:   $VERIFY_TOKEN

  দরকারি কমান্ড ($APP_DIR ফোল্ডারে):
    লগ দেখা:        docker compose logs -f app
    রিস্টার্ট:       docker compose restart app
    সেটিংস বদলানো:  nano .env  তারপর  docker compose up -d
    আপডেট:          এই install স্ক্রিপ্ট আবার চালান
    ব্যাকআপ:        bash deploy/backup.sh

EOF
grep -qE '^META_APP_SECRET=.+' .env || warn "META_APP_SECRET খালি আছে — .env এ দিয়ে 'docker compose up -d' চালান (webhook সিগনেচার যাচাইয়ের জন্য জরুরি)।"
