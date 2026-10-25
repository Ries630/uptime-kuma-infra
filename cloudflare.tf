# トンネルのシークレットは Terraform 側で作る。
# token の data source は Tunnel Write 権限を要するため、使わずに token を組み立て、plan を読み取り権限で流せるようにする。
resource "random_bytes" "tunnel_secret" {
  length = 32
}

# VM 上の cloudflared が使うトンネル。自宅側のトンネルを経由しないため、自宅が落ちてもステータスページは見える。
resource "cloudflare_zero_trust_tunnel_cloudflared" "uptime_kuma" {
  account_id    = var.cloudflare_account_id
  name          = "uptime-kuma-gce"
  config_src    = "cloudflare"
  tunnel_secret = random_bytes.tunnel_secret.base64
}

locals {
  # cloudflared の TUNNEL_TOKEN の形式（アカウント ID・トンネル ID・シークレットの JSON を base64 にしたもの）。
  tunnel_token = base64encode(jsonencode({
    a = var.cloudflare_account_id
    t = cloudflare_zero_trust_tunnel_cloudflared.uptime_kuma.id
    s = random_bytes.tunnel_secret.base64
  }))
}

# ホスト名ごと Uptime Kuma へ流す。どのパスを公開するかは Access 側で決める。
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "uptime_kuma" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.uptime_kuma.id

  config = {
    ingress = [
      {
        hostname = var.status_hostname
        service  = "http://uptime-kuma:3001"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

resource "cloudflare_dns_record" "status" {
  zone_id = var.cloudflare_zone_id
  name    = var.status_hostname
  type    = "CNAME"
  content = "${var.dns_cutover ? cloudflare_zero_trust_tunnel_cloudflared.uptime_kuma.id : var.legacy_tunnel_id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

locals {
  # ステータスページの表示に必要なパス。ブラウザで /status/<slug> を開いたときの通信から洗い出した。
  public_paths = [
    "/status/*",
    "/api/status-page/*",
    "/assets/*",
    "/upload/*",
    "/icon.svg",
    "/favicon.ico",
    "/manifest.json",
  ]
}

resource "cloudflare_zero_trust_access_policy" "bypass" {
  account_id = var.cloudflare_account_id
  name       = "Bypass"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

# ステータスページだけは認証なしで見せる。パスを指定したアプリはホスト全体のアプリより優先される。
resource "cloudflare_zero_trust_access_application" "status_public" {
  account_id       = var.cloudflare_account_id
  name             = "bypass-status"
  type             = "self_hosted"
  domain           = "${var.status_hostname}${local.public_paths[0]}"
  session_duration = "24h"
  destinations     = [for p in local.public_paths : { type = "public", uri = "${var.status_hostname}${p}" }]
  policies         = [{ id = cloudflare_zero_trust_access_policy.bypass.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_policy" "admin" {
  account_id = var.cloudflare_account_id
  name       = "uptime-kuma-admin"
  decision   = "allow"
  include    = [for e in var.admin_emails : { email = { email = e } }]
}

# 管理画面を含むホスト全体。admin_emails の本人だけが入れる。
resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.cloudflare_account_id
  name             = "uptime-kuma-admin"
  type             = "self_hosted"
  domain           = var.status_hostname
  session_duration = "24h"
  destinations     = [{ type = "public", uri = var.status_hostname }]
  policies         = [{ id = cloudflare_zero_trust_access_policy.admin.id, precedence = 1 }]
}
