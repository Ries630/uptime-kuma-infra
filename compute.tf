data "google_compute_image" "flatcar" {
  project = "kinvolk-public"
  family  = "flatcar-stable"
}

# Uptime Kuma のデータと Tailscale の state を置くディスク。VM を作り直しても残す。
resource "google_compute_disk" "data" {
  name = "uptime-kuma-data"
  type = "pd-standard"
  size = 10
  zone = var.zone

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_resource_policy" "daily_snapshot" {
  name   = "uptime-kuma-data-daily"
  region = var.region

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        # 17:00 UTC = 2:00 JST
        start_time = "17:00"
      }
    }

    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }

    snapshot_properties {
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "data_daily_snapshot" {
  name = google_compute_resource_policy.daily_snapshot.name
  disk = google_compute_disk.data.name
  zone = var.zone
}

data "ct_config" "uptime_kuma" {
  strict = true
  content = templatefile("${path.module}/butane/uptime-kuma.bu.tftpl", {
    ssh_authorized_keys = var.ssh_authorized_keys
    tunnel_token        = data.cloudflare_zero_trust_tunnel_cloudflared_token.uptime_kuma.token
    tailscale_auth_key  = var.tailscale_auth_key
  })
}

# Ignition は初回起動時にしか適用されないため、設定が変わったら VM を作り直す。
resource "terraform_data" "ignition" {
  input = sha256(data.ct_config.uptime_kuma.rendered)
}

resource "google_compute_instance" "uptime_kuma" {
  name         = "uptime-kuma"
  machine_type = "e2-micro"
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = data.google_compute_image.flatcar.self_link
      type  = "pd-standard"
      size  = 13
    }
  }

  # Butane 側では /dev/disk/by-id/scsi-0Google_PersistentDisk_data として参照する。
  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id

    # 外向き通信（イメージ取得・OS 更新・Tailscale・Tunnel）用。
    # Standard ティアは月 200 GiB までのインターネット向け転送が無料。
    access_config {
      network_tier = "STANDARD"
    }
  }

  # Ignition にはトンネルのトークンと Tailscale の認証キーが入るため、plan に出さない。
  metadata = {
    user-data = sensitive(data.ct_config.uptime_kuma.rendered)
  }

  # サービスアカウントは付けない。VM から GCP の API を呼ぶ処理が無いため。

  shielded_instance_config {
    enable_secure_boot          = false
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  lifecycle {
    # OS は Flatcar 自身が更新するため、イメージ系列の新版では作り直さない。
    # gcloud compute ssh が書き込む鍵も Terraform の管理外とする。
    ignore_changes       = [boot_disk[0].initialize_params[0].image, metadata["ssh-keys"]]
    replace_triggered_by = [terraform_data.ignition]
  }
}
