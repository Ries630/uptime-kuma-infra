# 手作業で作っていた既存の Cloudflare リソースを Terraform の管理下に取り込む。
# 取り込みが済んだあとは、このファイルを消してよい。

import {
  to = cloudflare_dns_record.status
  id = "${var.cloudflare_zone_id}/b733a66afc74c33bb0e2a14e0fb53e1c"
}

import {
  to = cloudflare_zero_trust_access_policy.bypass
  id = "${var.cloudflare_account_id}/1cef9f2b-086e-461a-a10b-58f398351485"
}

import {
  to = cloudflare_zero_trust_access_application.status_public
  id = "accounts/${var.cloudflare_account_id}/a08f1530-7b66-40b8-8049-e0016008f413"
}
