variable "project_id" {
  description = "GCP のプロジェクト ID。"
  type        = string
  default     = "uptime-kuma-470106"
}

variable "region" {
  description = "GCP のリージョン。e2-micro の無料枠がある us-west1 / us-central1 / us-east1 のいずれか。"
  type        = string
  default     = "us-west1"
}

variable "zone" {
  description = "GCP のゾーン。"
  type        = string
  default     = "us-west1-a"
}

variable "cloudflare_account_id" {
  description = "Cloudflare のアカウント ID。"
  type        = string
  default     = "5d80d84104fdc455506d8f2145a42173"
}

variable "cloudflare_zone_id" {
  description = "公開ホスト名が属する Cloudflare のゾーン ID。"
  type        = string
  default     = "2d00fe11e43880db4dfb9cc2e5579b34"
}

variable "status_hostname" {
  description = "ステータスページを公開するホスト名。"
  type        = string
  default     = "status.rieslab.dev"
}

variable "status_page_slug" {
  description = "外形監視で確認する Uptime Kuma のステータスページの slug。"
  type        = string
  default     = "home"
}

variable "dns_cutover" {
  description = "true で公開ホスト名を新しいトンネルへ向ける。false の間は legacy_tunnel_id のトンネルへ向けたままにする。"
  type        = bool
  default     = false
}

variable "legacy_tunnel_id" {
  description = "切り替え前に公開ホスト名を受けていたトンネル（自宅の home-tunnel）の ID。"
  type        = string
  default     = "3af24335-f3aa-4ae9-8430-49cdaf77791e"
}

variable "admin_emails" {
  description = "Cloudflare Access で管理画面へのログインを許すメールアドレス。"
  type        = list(string)
  # public リポジトリの plan 出力に載せないため sensitive にする。
  sensitive = true
}

variable "alert_email" {
  description = "外形監視の失敗を通知するメールアドレス。"
  type        = string
  # public リポジトリの plan 出力に載せないため sensitive にする。
  sensitive = true
}

variable "ssh_authorized_keys" {
  description = "VM の core ユーザーに登録する SSH 公開鍵。"
  type        = list(string)
}

variable "tailscale_auth_key" {
  description = "Tailscale の認証キー。初回ログインにだけ使い、以降はデータディスク上の state で再接続する。"
  type        = string
  sensitive   = true
}
