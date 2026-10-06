/** Feishu approval of an exact ServerOS grant; no authority from caller labels. */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { registerProviderApprovalAsk, type VerifiedAskCardAnswer } from '../../core/ask-broker.js';
import type { CreateAskInput } from '../../core/ask-types.js';
import { resolveVerifiedUserIdentity } from './identity-cache.js';

type Grant = Record<string, unknown>;
export interface SigningBinding {
  provider_id: string; key_id: string; audience: string; key: KeyObject;
}
const GRANT_FIELDS = new Set(['grant_ref', 'valid_from', 'expires_at', 'projects', 'items',
  'actions', 'scope_digests', 'covers', 'budget', 'engineering']);

/** The same sorted UTF-8 JSON contract used by the ServerOS verifier. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':'
      + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  throw new Error('grant must contain only JSON values and safe integers');
}

export function validateGrant(raw: unknown, now = Date.now()): Grant {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('grant must be an object');
  const grant = JSON.parse(canonicalJson(raw)) as Grant;
  if (Object.keys(grant).some(k => !GRANT_FIELDS.has(k))) throw new Error('unsupported grant field');
  for (const name of ['grant_ref', 'valid_from', 'expires_at']) {
    if (typeof grant[name] !== 'string' || !(grant[name] as string).trim()) throw new Error(`missing ${name}`);
  }
  const start = Date.parse(grant.valid_from as string), end = Date.parse(grant.expires_at as string);
  if (![grant.valid_from, grant.expires_at].every(t => /(Z|[+-]\d\d:\d\d)$/.test(t as string))
    || !Number.isFinite(start) || !Number.isFinite(end) || end <= now || end <= start) throw new Error('invalid grant window');
  for (const name of ['actions', 'projects', 'items', 'covers']) {
    if (grant[name] !== undefined && (!Array.isArray(grant[name])
      || (grant[name] as unknown[]).some(v => typeof v !== 'string' || !v))) throw new Error(`invalid ${name}`);
  }
  if (!(grant.actions as unknown[] | undefined)?.length) throw new Error('actions are required');
  if (!(grant.items as unknown[] | undefined)?.length && !(grant.covers as unknown[] | undefined)?.length) throw new Error('scope is required');
  const items = grant.items as string[] | undefined;
  const digests = grant.scope_digests as Record<string, unknown> | undefined;
  if (items?.length && (!(grant.projects as string[] | undefined)?.length || !digests
    || items.some(id => typeof digests[id] !== 'string' || !(digests[id] as string).trim()))) throw new Error('item scope requires project and scope digest');
  const engineering = (grant.actions as string[]).includes('engineering.execute');
  if (engineering !== ('engineering' in grant) || (engineering && (!grant.engineering
    || typeof grant.engineering !== 'object' || Array.isArray(grant.engineering)))) throw new Error('engineering action requires its binding');
  const budget = grant.budget as Record<string, unknown> | undefined;
  if (!budget || budget.exhausted !== false || ['wall_seconds', 'max_attempts', 'max_output_bytes']
    .some(k => !Number.isSafeInteger(budget[k]) || (budget[k] as number) <= 0)) throw new Error('positive bounded budget required');
  if (Buffer.byteLength(canonicalJson(grant)) > 6000) throw new Error('grant exceeds approval card budget');
  return grant;
}

function readPrivateFile(path: string): string {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0
    || st.uid !== process.getuid?.() || realpathSync(path) !== path) throw new Error('provider binding must be owner-only and not a symlink');
  return readFileSync(path, 'utf8');
}

export function loadSigningBinding(): SigningBinding {
  const home = homedir();
  const config = JSON.parse(readPrivateFile(join(home, '.config/serveros/botmux-delegation-provider.json')));
  for (const name of ['provider_id', 'key_id', 'audience', 'private_key_file']) {
    if (typeof config[name] !== 'string' || !config[name]) throw new Error(`unbound ${name}`);
  }
  const vault = realpathSync(join(home, '.secrets/vault'));
  const keyPath = config.private_key_file as string;
  const rel = isAbsolute(keyPath) ? relative(vault, keyPath) : '..';
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('signing key must be inside the provider vault');
  const key = createPrivateKey(readPrivateFile(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('provider requires Ed25519');
  return { provider_id: config.provider_id, key_id: config.key_id, audience: config.audience, key };
}

export function signApproval(binding: SigningBinding, grant: Grant,
  event: VerifiedAskCardAnswer, route: Pick<CreateAskInput, 'chatId' | 'rootMessageId'>, unionId: string) {
  if (!unionId || !event.messageId) throw new Error('verified human identity is unavailable');
  // quote(..., safe='') compatibility with the Python actor-ref producer.
  const actorId = encodeURIComponent(unionId).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const payload = {
    schema: 'serveros/human-delegation.v1', provider_id: binding.provider_id,
    key_id: binding.key_id, audience: binding.audience, issued_at: new Date().toISOString(),
    actor_report: {
      human_control_provider: binding.provider_id, transport: 'feishu',
      transport_identity: `${event.larkAppId}/${event.by}`,
      conversation_ref: route.rootMessageId ? `${route.chatId}/${route.rootMessageId}` : route.chatId,
      message_ref: `${event.messageId}/ask/${event.askId}`, observed_at: event.observedAt,
      provider_status: 'VERIFIED', provenance: 'FACT', actor_ref: `feishu:union:${actorId}`,
    }, grant,
  };
  return { payload, signature: sign(null, Buffer.from(canonicalJson(payload), 'utf8'), binding.key).toString('base64') };
}

export async function requestServerosDelegation(
  route: Pick<CreateAskInput, 'sessionId' | 'larkAppId' | 'chatId' | 'rootMessageId' | 'chatType'>
    & { answererOpenId: string }, raw: unknown,
) {
  const grant = validateGrant(raw);
  const binding = loadSigningBinding(); // Fail before sending if not configured.
  let proof: Promise<ReturnType<typeof signApproval>> | undefined;
  const result = await registerProviderApprovalAsk({
    ...route, timeoutMs: 300_000,
    questions: [{ multiSelect: false,
      prompt: '允许 ServerOS 在下面的范围、预算和期限内继续工作吗？拒绝不会影响其他工作。\n\n'
        + '```json\n' + JSON.stringify(grant, null, 2) + '\n```',
      options: [{ key: 'approve', label: '批准此范围' }, { key: 'reject', label: '拒绝' }],
    }],
  }, event => {
    proof = (async () => {
      const human = await resolveVerifiedUserIdentity(event.larkAppId, event.by);
      if (!human?.unionId || human.openId !== route.answererOpenId) throw new Error('human identity could not be verified');
      return signApproval(binding, grant, event, route, human.unionId);
    })();
    // The ask Promise resumes on the next microtask; suppress an unhandled
    // rejection here while preserving the failure returned to its requester.
    void proof.catch(() => {});
  });
  if (result.kind !== 'answered' || !proof) return { ok: false, status: 'NOT_VERIFIED_APPROVAL' };
  return { ok: true, status: 'HUMAN_APPROVED', evidence: await proof };
}
