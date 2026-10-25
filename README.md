# uptime-kuma-infra

自宅環境を外から監視する [Uptime Kuma](https://github.com/louislam/uptime-kuma) を、GCE の e2-micro（無料枠）上に Terraform で構築する。

## 構成

```
                       ┌──────────── GCE e2-micro（Flatcar Container Linux）────────────┐
 閲覧者 ── Cloudflare ─┼─ cloudflared ──▶ Uptime Kuma ── Tailscale ──▶ 自宅の監視対象 │
          （Access）   │                    │                                         │
                       │              /mnt/data（データ専用 PD、日次スナップショット）│
                       └──────────────────────────────────────────────────────────────┘
 Cloud Monitoring の外形監視 ──▶ ステータスページ（監視サーバー自身の死活）
```

- **OS**: Flatcar Container Linux（stable）。OS は自動で更新し、月曜 4:00〜5:00 JST の枠で再起動する
- **起動設定**: [butane/uptime-kuma.bu.tftpl](butane/uptime-kuma.bu.tftpl)。Ignition は初回起動時にしか適用されないため、内容を変えると `terraform apply` で VM が作り直される
- **データ**: Uptime Kuma のデータと Tailscale の state は `uptime-kuma-data` ディスクに置く。VM を作り直しても残り、毎日 2:00 JST にスナップショットを取る（7 日分）
- **コンテナ**: Uptime Kuma（`louislam/uptime-kuma:2`）、Tailscale、cloudflared を systemd unit から `docker run` で動かす。イメージは月曜 3:00 JST に更新する
- **公開**: VM 上の cloudflared から Cloudflare Tunnel で公開する。ステータスページに要るパスだけ Access を素通しにし、それ以外（管理画面）は Access の認証を通す
- **受信ポート**: IAP 経由の SSH だけ。外部 IP は外向き通信のために付けている
- **外形監視**: Cloud Monitoring の Uptime check が `/api/status-page/heartbeat/<slug>` を 5 分ごとに確認し、失敗が続くとメールで通知する

| ファイル | 内容 |
|---|---|
| [versions.tf](versions.tf) | provider と backend（GCS） |
| [network.tf](network.tf) | 専用 VPC とファイアウォール |
| [compute.tf](compute.tf) | VM、データディスク、スナップショット、Ignition の生成 |
| [cloudflare.tf](cloudflare.tf) | トンネル、DNS、Access |
| [monitoring.tf](monitoring.tf) | 外形監視と通知 |
| [imports.tf](imports.tf) | 手作業で作った既存の Cloudflare リソースの取り込み |

## 初回セットアップ

1. state 用のバケットを作る（作成済み）

   ```bash
   gcloud storage buckets create gs://uptime-kuma-470106-tfstate --project=uptime-kuma-470106 --location=us-west1 --uniform-bucket-level-access --public-access-prevention
   ```

   ```bash
   gcloud storage buckets update gs://uptime-kuma-470106-tfstate --versioning
   ```

2. 認証情報を用意する。GCP は `gcloud auth application-default login` の ADC を使う。Cloudflare の API トークンと Tailscale の認証キーは環境変数で渡す

   | 変数 | 内容 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | Account: Cloudflare Tunnel Write、Access: Apps and Policies Write、Access: Organizations, Identity Providers, and Groups Read／Zone: DNS Write、Zone Read |
   | `TF_VAR_tailscale_auth_key` | 使い捨ての認証キー。初回ログイン後は不要 |

3. `terraform.tfvars.example` を `terraform.tfvars` にコピーして値を入れ、`terraform init` する

## 運用

- **SSH**: `gcloud compute ssh core@uptime-kuma --zone us-west1-a --tunnel-through-iap`
- **状態確認**: `systemctl status tailscale uptime-kuma cloudflared`、`docker ps`、`systemctl list-timers container-refresh.timer`
- **OS 更新の状況**: `update_engine_client -status`
- **イメージを今すぐ更新する**: `sudo systemctl start container-refresh.service`
- **データを戻す**: `uptime-kuma-data` のスナップショットからディスクを作り、`google_compute_disk.data` と差し替える
- **OS の作り直し**: 起動設定を変えて `terraform apply` すると、データディスクを残したまま VM だけ作り直される

## 旧 VM（Ubuntu）からの移行手順

1. 旧 VM のディスクのスナップショットを取る
2. `dns_cutover = false` のまま `terraform apply` し、新 VM を立てる。公開ホスト名はまだ旧経路（自宅の `home-tunnel`）を向いている
3. 新 VM で `uptime-kuma.service` を止め、`/mnt/data/uptime-kuma` を空にする
4. 旧 VM で自動更新の timer とコンテナを止め、`/opt/uptime-kuma/uptime-kuma-data` を tar で取り出し、新 VM の `/mnt/data/uptime-kuma` に展開する
5. 新 VM で `uptime-kuma.service` を起動し、healthy になって監視が通ることを Tailscale 経由で確かめる
6. `dns_cutover = true` にして `terraform apply` し、公開ホスト名を新しいトンネルへ向ける
7. `home-tunnel` の公開ルールから `status.rieslab.dev` を外し、旧 VM を停止する
