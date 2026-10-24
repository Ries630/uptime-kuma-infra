terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.8"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    ct = {
      source  = "poseidon/ct"
      version = "~> 0.14"
    }
  }

  # state にはトンネルのトークンなどの秘密情報が入るため、リポジトリには置かず GCS に置く。
  # バケットは Terraform の外で作成済み（README の「初回セットアップ」参照）。
  backend "gcs" {
    bucket = "uptime-kuma-470106-tfstate"
    prefix = "uptime-kuma"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# 認証は環境変数 CLOUDFLARE_API_TOKEN から読む。
provider "cloudflare" {}
