output "instance_name" {
  description = "VM 名。SSH は gcloud compute ssh core@<この名前> --zone <zone> --tunnel-through-iap。"
  value       = google_compute_instance.uptime_kuma.name
}

output "tunnel_id" {
  description = "VM 上の cloudflared が使うトンネルの ID。"
  value       = cloudflare_zero_trust_tunnel_cloudflared.uptime_kuma.id
}

output "status_dns_target" {
  description = "公開ホスト名の現在の向き先。"
  value       = cloudflare_dns_record.status.content
}
