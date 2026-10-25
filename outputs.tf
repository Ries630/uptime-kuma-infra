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

output "github_workload_identity_provider" {
  description = "GitHub の terraform-plan environment の変数 GCP_WORKLOAD_IDENTITY_PROVIDER に入れる値。"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_plan_service_account" {
  description = "GitHub の terraform-plan environment の変数 GCP_SERVICE_ACCOUNT に入れる値。"
  value       = google_service_account.terraform_plan.email
}
