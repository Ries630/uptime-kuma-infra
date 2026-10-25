import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPlanError, describePlanError, isTrustedPull, parseInputs } from './plan.mjs';

const sha = 'a'.repeat(40);

/** 所有者が同じリポジトリから出した PR のイベントと環境変数を作る。 */
function trusted() {
  return {
    event: {
      repository: { full_name: 'Ries630/uptime-kuma-infra', owner: { login: 'Ries630' } },
      pull_request: { user: { login: 'Ries630' }, head: { sha, repo: { full_name: 'Ries630/uptime-kuma-infra' } } },
    },
    env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'Ries630/uptime-kuma-infra', GITHUB_ACTOR: 'Ries630', EXPECTED_HEAD_SHA: sha },
  };
}

test('所有者の同一リポジトリ PR だけを信頼する', () => {
  const { event, env } = trusted();
  assert.ok(isTrustedPull(event, env));
  assert.ok(!isTrustedPull(event, { ...env, GITHUB_ACTOR: 'someone' }));
  assert.ok(!isTrustedPull(event, { ...env, GITHUB_EVENT_NAME: 'pull_request_target' }));
  assert.ok(!isTrustedPull(event, { ...env, EXPECTED_HEAD_SHA: 'b'.repeat(40) }));
  const fork = structuredClone(event);
  fork.pull_request.head.repo.full_name = 'someone/uptime-kuma-infra';
  assert.ok(!isTrustedPull(fork, env));
});

test('入力は決めた変数と型だけを受け付け、秘密の値を返す', () => {
  const valid = {
    admin_emails: ['a@example.com'], alert_email: 'b@example.com',
    ssh_authorized_keys: ['ssh-ed25519 AAAA'], tailscale_auth_key: 'tskey-auth-x', dns_cutover: true,
  };
  const { secrets } = parseInputs(JSON.stringify(valid));
  assert.deepEqual(secrets.sort(), ['a@example.com', 'b@example.com', 'tskey-auth-x']);
  assert.throws(() => parseInputs(JSON.stringify({ ...valid, project_id: 'other' })));
  assert.throws(() => parseInputs(JSON.stringify({ ...valid, dns_cutover: 'true' })));
  const { tailscale_auth_key: _, ...missing } = valid;
  assert.throws(() => parseInputs(JSON.stringify(missing)));
});

test('認可の失敗だけを区別する', () => {
  assert.equal(classifyPlanError({ stderr: 'googleapi: Error 403: Permission denied' }), 'authorization');
  assert.equal(classifyPlanError({ stderr: 'Error: Invalid reference' }), 'unknown');
  assert.equal(classifyPlanError(new Error('x')), 'unknown');
});

test('失敗の手がかりはアドレスと権限名だけを出す', () => {
  const stderr = [
    '╷',
    '│ Error: Error reading NotificationChannel: googleapi: Error 403: Permission \'monitoring.notificationChannels.get\' denied on resource alert@example.com',
    '│ ',
    '│   with google_monitoring_notification_channel.email,',
    '│   on monitoring.tf line 23, in resource "google_monitoring_notification_channel" "email":',
    '│   with google_project_iam_member.terraform_plan["roles/viewer"],',
    '╵',
  ].join('\n');
  const detail = describePlanError({ stderr });
  assert.equal(detail, [
    'api:google',
    'permission:monitoring.notificationChannels.get',
    'resource:google_monitoring_notification_channel.email',
    'resource:google_project_iam_member.terraform_plan["roles/viewer"]',
  ].join(' '));
  assert.ok(!detail.includes('alert@example.com'));
  assert.equal(describePlanError({ stderr: 'googleapi: Error 403: API has not been used.\nDetails:\n[{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "SERVICE_DISABLED"}]' }),
    'api:google reason:SERVICE_DISABLED');
  assert.equal(describePlanError(new Error('x')), '');
});
