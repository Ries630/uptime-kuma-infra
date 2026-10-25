# GitHub Actions の PR で terraform plan を流すための認証。
# このリポジトリの terraform-plan environment で動くジョブだけが、plan 専用のサービスアカウントを借りられる。

locals {
  # Ries630/uptime-kuma-infra とその所有者。名前の付け替えや同名の作り直しで信頼が引き継がれないよう、数値 ID で照合する。
  github_repository_id = "1431804544"
  github_owner_id      = "82589136"
}

resource "google_project_service" "ci" {
  for_each = toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.ci]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "uptime-kuma-infra"
  display_name                       = "uptime-kuma-infra"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository_id"    = "assertion.repository_id"
    "attribute.repository_owner" = "assertion.repository_owner_id"
    "attribute.environment"      = "assertion.environment"
  }

  # このリポジトリの terraform-plan environment 以外のトークンは、交換の時点で拒否する。
  # sub の書式はリポジトリの OIDC 設定で変わるため、個別のクレームで照合する。
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${local.github_repository_id}'",
    "assertion.repository_owner_id == '${local.github_owner_id}'",
    "assertion.environment == 'terraform-plan'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# plan 専用。書き込み権限は持たせない。
resource "google_service_account" "terraform_plan" {
  account_id   = "terraform-plan"
  display_name = "terraform plan (GitHub Actions)"
}

resource "google_service_account_iam_member" "terraform_plan_wif" {
  service_account_id = google_service_account.terraform_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${local.github_repository_id}"
}

# viewer だけでは IAM ポリシー（バケットの IAM など）を読めないため、securityReviewer を足す。
resource "google_project_iam_member" "terraform_plan" {
  for_each = toset([
    "roles/viewer",
    "roles/iam.securityReviewer",
  ])

  project = var.project_id
  role    = each.value
  member  = google_service_account.terraform_plan.member
}

# state の読み取り。CI はロックを取らずに plan するため、書き込み権限は要らない。
resource "google_storage_bucket_iam_member" "terraform_plan_state" {
  bucket = "uptime-kuma-470106-tfstate"
  role   = "roles/storage.objectViewer"
  member = google_service_account.terraform_plan.member
}
