import { spawnSync } from 'node:child_process';

export const marker = '<!-- terraform-plan -->';

// この構成で使う provider だけを許す。別の provider が紛れ込んだ plan は公開しない。
const allowedProviders = new Set([
  'registry.terraform.io/hashicorp/google',
  'registry.terraform.io/cloudflare/cloudflare',
  'registry.terraform.io/hashicorp/random',
  'terraform.io/builtin/terraform',
]);
const supportedActions = new Set(['no-op', 'create', 'update', 'delete', 'delete,create', 'create,delete']);
// 短すぎる値で置換すると無関係な文字列まで潰れるため、照合はこの長さ以上の値に限る。
const minimumSecretLength = 8;

/** 子 module を含むリソースを列挙する。 */
function resourcesIn(module) {
  return [
    ...(module?.resources ?? []),
    ...(module?.child_modules ?? []).flatMap(resourcesIn),
  ];
}

/** 配列・オブジェクトのキーも含めて、すべての文字列を変換する。 */
function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      transform(key), mapStrings(item, transform),
    ]));
  }
  return value;
}

/** 値に含まれる文字列をすべて集める。 */
function collectStrings(value, into) {
  if (typeof value === 'string') into.add(value);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

/** sensitive とされた値を伏せ、伏せた元の文字列を secrets に集める。 */
function maskSensitive(value, mask, secrets) {
  if (mask === true) {
    collectStrings(value, secrets);
    return value === null ? null : '(sensitive)';
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => maskSensitive(item, mask?.[index], secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, maskSensitive(item, mask?.[key], secrets),
    ]));
  }
  return value;
}

/**
 * VM の起動設定に埋め込まれるトンネルのトークンを state から組み立てる。
 * Terraform の jsonencode と同じくキーを辞書順に並べるので、cloudflare.tf の local.tunnel_token と同じ文字列になる。
 */
function tunnelTokens(plan) {
  const resources = [
    ...resourcesIn(plan.prior_state?.values?.root_module),
    ...resourcesIn(plan.planned_values?.root_module),
  ];
  const secrets = resources.filter((r) => r.mode === 'managed' && r.type === 'random_bytes')
    .map((r) => r.values?.base64).filter((v) => typeof v === 'string');
  const tunnels = resources.filter((r) => r.mode === 'managed' && r.type === 'cloudflare_zero_trust_tunnel_cloudflared')
    .filter((r) => typeof r.values?.id === 'string' && typeof r.values?.account_id === 'string');
  return tunnels.flatMap(({ values }) => secrets.map((s) =>
    Buffer.from(JSON.stringify({ a: values.account_id, s, t: values.id })).toString('base64')));
}

/** plan が完了しており、想定した provider と操作だけを含むことを確かめる。 */
export function validatePlan(plan) {
  if (plan?.errored || plan?.complete === false || !Array.isArray(plan?.resource_changes)) {
    throw new Error('完了した plan が必要です。');
  }
  for (const resource of [...plan.resource_changes, ...(plan.resource_drift ?? [])]) {
    if (resource.mode !== 'managed') continue;
    if (!allowedProviders.has(resource.provider_name) ||
        !supportedActions.has(resource.change?.actions?.join(','))) {
      throw new Error('未対応のリソースまたは操作が含まれています。');
    }
  }
}

/**
 * plan JSON から公開してよい部分だけを取り出す。
 * data source、state 全体、変数は tfplan2md の表示に要らず、起動設定のように秘密を含む値があるため渡さない。
 * @param {object} input terraform show -json の結果
 * @param {string[]} extraSecrets 入力変数など、plan の外から分かっている秘密の値
 * @returns {{ counts: object, plan: object, assertSafe: (text: string) => void }}
 */
export function prepareReport(input, extraSecrets = []) {
  validatePlan(input);
  const secrets = new Set([...extraSecrets, ...tunnelTokens(input)]);
  // sensitive の値は、別の属性に複製されていても見つけられるよう先に集める。
  for (const values of [input.prior_state?.values, input.planned_values]) {
    for (const resource of resourcesIn(values?.root_module)) {
      maskSensitive(resource.values, resource.sensitive_values, secrets);
    }
  }
  for (const [key, metadata] of Object.entries(input.configuration?.root_module?.variables ?? {})) {
    if (metadata.sensitive) collectStrings(input.variables?.[key]?.value, secrets);
  }

  const counts = { add: 0, change: 0, destroy: 0, import: 0 };
  const masked = (resource) => ({
    ...resource,
    change: {
      ...resource.change,
      before: maskSensitive(resource.change.before, resource.change.before_sensitive, secrets),
      after: maskSensitive(resource.change.after, resource.change.after_sensitive, secrets),
    },
  });
  const changes = input.resource_changes.filter((r) => r.mode === 'managed').map(masked);
  for (const { change } of changes) {
    if (change.actions.includes('create')) counts.add += 1;
    if (change.actions.includes('update')) counts.change += 1;
    if (change.actions.includes('delete')) counts.destroy += 1;
    if (change.importing) counts.import += 1;
  }
  const outputs = Object.fromEntries(Object.entries(input.output_changes ?? {}).map(([name, change]) => [name, {
    ...change,
    before: maskSensitive(change.before, change.before_sensitive, secrets),
    after: maskSensitive(change.after, change.after_sensitive, secrets),
  }]));

  const privateValues = [...secrets].filter((v) => typeof v === 'string' && v.length >= minimumSecretLength)
    .sort((left, right) => right.length - left.length);
  const plan = mapStrings({
    format_version: input.format_version,
    terraform_version: input.terraform_version,
    resource_changes: changes,
    resource_drift: (input.resource_drift ?? []).filter((r) => r.mode === 'managed').map(masked),
    output_changes: outputs,
  }, (text) => privateValues.reduce((t, secret) => t.split(secret).join('(sensitive)'), text));

  /** 公開用の文字列に、秘密の値がそのままでも符号化されても残っていないことを確かめる。 */
  function assertSafe(text) {
    for (const value of privateValues) {
      for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
        if (text.includes(form)) throw new Error('公開用レポートに非公開の値が残っています。');
      }
    }
  }
  assertSafe(JSON.stringify(plan));
  return { counts, plan, assertSafe };
}

/**
 * 固定版の tfplan2md で PR コメント用の Markdown を作る。
 * @param {object} input terraform show -json の結果
 * @param {{ renderer?: string, extraSecrets?: string[] }} options
 * @returns {string} 先頭に marker を付けた Markdown
 */
export function renderReport(input, { renderer = 'tfplan2md', extraSecrets = [] } = {}) {
  const { counts, plan, assertSafe } = prepareReport(input, extraSecrets);
  const result = spawnSync(renderer, [
    '--render-target', 'github', '--details', 'closed', '--hide-metadata',
  ], { input: JSON.stringify(plan), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    // renderer の診断には入力の一部が含まれ得るため、公開ログへ転記しない。
    throw new Error('tfplan2md による変換に失敗しました。');
  }
  const body = [
    marker,
    '## Terraform plan',
    '',
    `**import: ${counts.import} / add: ${counts.add} / change: ${counts.change} / destroy: ${counts.destroy}**`,
    '',
    'sensitive な値は伏せています。この表示は apply の承認ではありません。',
    '',
    result.stdout.trim(),
    '',
  ].join('\n');
  assertSafe(body);
  if (Buffer.byteLength(body, 'utf8') > 60_000) {
    throw new Error('PR コメントの上限を超えるため、公開を中止しました。');
  }
  return body;
}
