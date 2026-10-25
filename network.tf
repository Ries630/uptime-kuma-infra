# 専用の VPC。default ネットワークの 0.0.0.0/0 向け許可ルールを引き継がないために分ける。
resource "google_compute_network" "main" {
  name                    = "uptime-kuma"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "uptime-kuma-${var.region}"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

# 受信は IAP 経由の SSH だけを許す。
# 公開経路の Cloudflare Tunnel と Tailscale はどちらも VM から外へつなぐため、受信ポートは要らない。
resource "google_compute_firewall" "allow_iap_ssh" {
  name          = "uptime-kuma-allow-iap-ssh"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
