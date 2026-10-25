import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderReport } from './report.mjs';

const repository = 'Ries630/uptime-kuma-infra';

// TERRAFORM_INPUTS に入れてよい変数と、その型。これ以外の変数は CI から上書きさせない。
const inputSchema = {
  admin_emails: { required: true, check: (v) => Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string'), secret: true },
  alert_email: { required: true, check: (v) => typeof v === 'string', secret: true },
  ssh_authorized_keys: { required: true, check: (v) => Array.isArray(v) && v.every((k) => typeof k === 'string'), secret: false },
  tailscale_auth_key: { required: true, check: (v) => typeof v === 'string' && v.length > 0, secret: true },
  dns_cutover: { required: false, check: (v) => typeof v === 'boolean', secret: false },
};

/** 所有者が同じリポジトリから出した PR だけを許す。workflow の入口でも使う。 */
export function isTrustedPull(event, env = process.env) {
  const pull = event.pull_request;
  return env.GITHUB_EVENT_NAME === 'pull_request' &&
    event.repository?.full_name === repository &&
    event.repository.full_name === env.GITHUB_REPOSITORY &&
    pull?.head?.repo?.full_name === env.GITHUB_REPOSITORY &&
    pull.user?.login === event.repository.owner.login &&
    env.GITHUB_ACTOR === event.repository.owner.login &&
    /^[0-9a-f]{40}$/i.test(env.EXPECTED_HEAD_SHA ?? '') && pull.head.sha === env.EXPECTED_HEAD_SHA;
}

/**
 * TERRAFORM_INPUTS（tfvars の JSON）を検証する。
 * @returns {{ inputs: object, secrets: string[] }} Terraform へ渡す値と、レポートから伏せる値
 */
export function parseInputs(text) {
  const inputs = JSON.parse(text);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) ||
      Object.keys(inputs).some((key) => !Object.hasOwn(inputSchema, key)) ||
      Object.entries(inputSchema).some(([key, { required, check }]) =>
        Object.hasOwn(inputs, key) ? !check(inputs[key]) : required)) {
    throw new Error('plan の入力が不正です。');
  }
  const secrets = Object.entries(inputSchema).filter(([, { secret }]) => secret)
    .flatMap(([key]) => [inputs[key]].flat()).filter((v) => typeof v === 'string');
  return { inputs, secrets };
}

/** stderr だけから認可の失敗かどうかを判定し、診断の中身は返さない。 */
export function classifyPlanError(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') :
    typeof error?.stderr === 'string' ? error.stderr : '';
  return /\b(401|403)\b|PERMISSION_DENIED|Unauthorized|Authentication error/i.test(stderr) ? 'authorization' : 'unknown';
}

/**
 * stderr から、公開しても問題ない手がかりだけを抜き出す。
 * 対象はリソースのアドレス（リポジトリのコードに書かれている）、GCP の権限名、どの API が拒否したかに限り、エラー本文は出さない。
 */
export function describePlanError(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') :
    typeof error?.stderr === 'string' ? error.stderr : '';
  const found = new Set();
  for (const [, address] of stderr.matchAll(/^[\s│]*with ((?:data\.)?[a-z0-9_]+\.[a-z0-9_]+(?:\["[a-zA-Z0-9_./-]+"\])?),/gm)) {
    found.add(`resource:${address}`);
  }
  // googleapi の 'Permission 'x.y.z' denied' と、エラー詳細の JSON の "permission": "x.y.z" の2つの書き方がある。
  for (const [, permission] of stderr.matchAll(/(?:Permission '|"permission":\s*")([a-z]+(?:\.[a-zA-Z]+){2})['"]/g)) {
    found.add(`permission:${permission}`);
  }
  if (/googleapi/.test(stderr)) found.add('api:google');
  if (/api\.cloudflare\.com/.test(stderr)) found.add('api:cloudflare');
  return [...found].sort().slice(0, 20).join(' ');
}

/** CI の秘密の入力から saved plan を作り、検証済みの Markdown だけを残す。 */
export function runPlan({ root = '.', output, event, env = process.env,
  run = execute, render = renderReport, onStage = () => {} } = {}) {
  onStage('input');
  if (!isTrustedPull(event, env)) throw new Error('信頼できる PR ではありません。');
  const { inputs, secrets } = parseInputs(env.TERRAFORM_INPUTS);
  if (env.CLOUDFLARE_API_TOKEN) secrets.push(env.CLOUDFLARE_API_TOKEN);
  root = resolve(root);
  const directory = mkdtempSync(join(tmpdir(), 'uptime-kuma-plan-'));
  const tfvars = join(root, 'ci.auto.tfvars.json');
  writeFileSync(tfvars, JSON.stringify(inputs), { mode: 0o600, flag: 'wx' });
  try {
    const call = (...args) => run('terraform', [`-chdir=${root}`, ...args], env);
    onStage('init');
    call('init', '-input=false', '-no-color', '-lockfile=readonly');
    onStage('validate');
    call('validate', '-no-color');
    const saved = join(directory, 'plan.tfplan');
    onStage('plan');
    // CI は state を読むだけにするため、ロックを取らない（ロックには state バケットへの書き込み権限が要る）。
    call('plan', '-input=false', '-no-color', '-lock=false', `-out=${saved}`);
    onStage('show');
    const plan = JSON.parse(call('show', '-json', saved));
    onStage('render');
    const body = render(plan, { renderer: env.TFPLAN2MD_PATH, extraSecrets: secrets });
    onStage('write');
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, body, { mode: 0o600, flag: 'wx' });
  } finally {
    rmSync(tfvars, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Terraform の生ログを公開せず、標準出力だけを呼び出し元へ返す。 */
function execute(program, args, env) {
  return execFileSync(program, args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stage = 'context';
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (process.argv[2] === 'check-context') {
      if (!isTrustedPull(event)) throw new Error('信頼できる PR ではありません。');
    } else {
      runPlan({ event, output: process.argv[2], onStage: (value) => { stage = value; } });
    }
  } catch (error) {
    console.error(`PR の plan 処理を中止しました。stage=${stage} category=${classifyPlanError(error)} detail=${describePlanError(error) || 'none'}`);
    process.exitCode = 1;
  }
}
