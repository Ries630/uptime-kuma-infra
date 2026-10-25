import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareReport, validatePlan } from './report.mjs';

const google = 'registry.terraform.io/hashicorp/google';
const tunnelSecret = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==';

/** テスト用の最小の plan JSON を作る。 */
function samplePlan(overrides = {}) {
  return {
    format_version: '1.2',
    terraform_version: '1.16.5',
    complete: true,
    errored: false,
    variables: { alert_email: { value: 'alert@example.com' } },
    configuration: { root_module: { variables: { alert_email: { sensitive: true } } } },
    prior_state: { values: { root_module: { resources: [
      { mode: 'managed', type: 'random_bytes', values: { base64: tunnelSecret }, sensitive_values: { base64: true } },
      { mode: 'managed', type: 'cloudflare_zero_trust_tunnel_cloudflared', values: { id: 'tunnel-id', account_id: 'account-id' }, sensitive_values: {} },
      { mode: 'data', type: 'ct_config', values: { rendered: 'ignition-with-secret' }, sensitive_values: {} },
    ] } } },
    resource_changes: [
      {
        address: 'google_compute_instance.uptime_kuma', mode: 'managed', type: 'google_compute_instance',
        name: 'uptime_kuma', provider_name: google,
        change: {
          actions: ['delete', 'create'],
          before: { metadata: { 'user-data': 'old-ignition' }, name: 'uptime-kuma' },
          after: { metadata: { 'user-data': 'new-ignition' }, name: 'uptime-kuma' },
          before_sensitive: { metadata: { 'user-data': true } },
          after_sensitive: { metadata: { 'user-data': true } },
        },
      },
      {
        address: 'google_monitoring_notification_channel.email', mode: 'managed',
        type: 'google_monitoring_notification_channel', name: 'email', provider_name: google,
        // sensitive の印が付かなかった場合でも、入力として分かっている値は伏せる。
        change: { actions: ['update'], before: { labels: { email_address: 'old@example.com' } },
          after: { labels: { email_address: 'alert@example.com' } }, before_sensitive: {}, after_sensitive: {} },
      },
      {
        address: 'data.ct_config.uptime_kuma', mode: 'data', type: 'ct_config', name: 'uptime_kuma',
        provider_name: 'registry.terraform.io/poseidon/ct',
        change: { actions: ['read'], before: null, after: { rendered: 'ignition-with-secret' } },
      },
    ],
    ...overrides,
  };
}

test('sensitive な値と入力の秘密を伏せ、data source を落とす', () => {
  const { plan, counts } = prepareReport(samplePlan(), ['old@example.com']);
  const text = JSON.stringify(plan);
  for (const secret of ['old-ignition', 'new-ignition', 'alert@example.com', 'old@example.com', 'ignition-with-secret']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(plan.resource_changes.length, 2);
  assert.equal(plan.prior_state, undefined);
  assert.equal(plan.variables, undefined);
  assert.deepEqual(counts, { add: 1, change: 1, destroy: 1, import: 0 });
});

test('state から組み立てたトンネルのトークンが出力に残っていれば止める', () => {
  const token = Buffer.from(JSON.stringify({ a: 'account-id', s: tunnelSecret, t: 'tunnel-id' })).toString('base64');
  const { assertSafe } = prepareReport(samplePlan());
  assert.throws(() => assertSafe(`TUNNEL_TOKEN=${token}`));
  assert.throws(() => assertSafe(encodeURIComponent(`TUNNEL_TOKEN=${token}`)));
  assert.doesNotThrow(() => assertSafe('no secrets here'));
});

test('未完了の plan や想定外の provider は公開しない', () => {
  assert.throws(() => validatePlan(samplePlan({ complete: false })));
  assert.throws(() => validatePlan(samplePlan({ errored: true })));
  const other = samplePlan();
  other.resource_changes[0].provider_name = 'registry.terraform.io/hashicorp/aws';
  assert.throws(() => validatePlan(other));
  const forget = samplePlan();
  forget.resource_changes[0].change.actions = ['forget'];
  assert.throws(() => validatePlan(forget));
});
