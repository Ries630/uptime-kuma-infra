# 監視サーバー自身の死活を外から見る。Uptime Kuma の API がデータを返せるかまで確認する。
resource "google_monitoring_uptime_check_config" "status_page" {
  display_name = "uptime-kuma status page"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/api/status-page/heartbeat/${var.status_page_slug}"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.status_hostname
    }
  }
}

resource "google_monitoring_notification_channel" "email" {
  display_name = "uptime-kuma alert email"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "status_page_down" {
  display_name          = "uptime-kuma status page down"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email.id]

  conditions {
    display_name = "外形監視が 2 地点以上で 10 分間失敗"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.status_page.uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }

      trigger {
        count = 1
      }
    }
  }
}
