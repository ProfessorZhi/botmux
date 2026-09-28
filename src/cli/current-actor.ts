import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { loopbackFetchImpl } from '../core/loopback-fetch.js';

export const CURRENT_ACTOR_SCHEMA = 'botmux.current-actor.v3' as const;
export const CURRENT_ACTOR_ROUTE = '/api/current-actor';

/**
 * The only identity kind a document may carry as canonical.
 *
 * Lark issues three ids for one person and they are not interchangeable:
 * `open_id` (`ou_…`) is scoped to the app that observed it, an email is an
 * attribute behind a field-level tenant permission, and `union_id` (`on_…`) is
 * scoped to the developer and therefore stable across every app that developer
 * owns. Only the last one identifies a person rather than recording one app's
 * view of them, which is why it is the one published as canonical.
 */
export const CANONICAL_ID_KIND_UNION = 'union_id' as const;

export interface CurrentActorDocument {
  schema: typeof CURRENT_ACTOR_SCHEMA;
  status: 'verified';
  actor: {
    /** The canonical human identity: developer-scoped, portable across apps. */
    canonical: { kind: typeof CANONICAL_ID_KIND_UNION; value: string };
    /**
     * App-local evidence about the same person.
     *
     * Kept so a consumer can tell which app's view of the actor this was, and
     * so the pairing itself is attested: both values came out of one Contact
     * response for one `open_id`. `open_id` is deliberately NOT the canonical
     * identity — a value that only means something inside one app cannot be the
     * name a cross-app control plane records.
     */
    appLocal: { larkAppId: string; openId: string };
    /** Display name. An attribute, not evidence: absent when unresolved. */
    displayName?: string;
    /**
     * Email, when the tenant exposes it.
     *
     * Deliberately optional, and deliberately not load-bearing. Reading it
     * requires `contact:user.email:readonly`, a field-level permission over
     * personal data; making it a condition of verification would make the whole
     * gate depend on that grant, and the gate would be structurally unavailable
     * to every app that does not hold it.
     */
    email?: string;
  };
  /**
   * The conversation this turn is in (`chat_id`).
   *
   * Published because the gate is the one channel that reaches a client through
   * the daemon's own verification, and a consumer that must record WHICH
   * conversation a human act came from otherwise has nothing attested to record:
   * `BOTMUX_CHAT_ID` is exported into the CLI too, but the environment is
   * writable by whoever spawned the process, so a value read from it is the
   * caller's claim rather than the daemon's statement. The same value is already
   * in the CLI's environment, so publishing it here adds no new exposure — it
   * only makes it attested rather than claimed.
   */
  chatId: string;
  /**
   * The daemon's identity for this exact turn (`managedTurnOrigin.turnId`).
   *
   * On a human message turn this IS the triggering Lark `message_id`: the
   * ingress paths bind `session.quoteTargetId` to that message id, and
   * `current-turn-provenance` refuses a turn whose marker disagrees with it.
   * On a scheduled/system turn it is a daemon-minted id instead. Either way it
   * is daemon-issued, unguessable and unique per turn, which is what a consumer
   * needs in order to make one human act authorize exactly one thing.
   */
  turnId: string;
}
export interface ResolveCurrentActorOptions {
  ipcPort: number;
  sessionId: string;
  /** When set, the daemon must also prove this exact scheduled turn remains
   *  registered as in-flight before returning the actor document. */
  expectedScheduledTurnId?: string;
  fetchImpl?: typeof fetch;
}

export interface BotmuxAncestorContext {
  sessionId: string;
  larkAppId: string;
  ipcPort: number;
}

export class CurrentActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrentActorError';
  }
}

export function parseCurrentActorArgs(args: string[]): { ok: true } | { ok: false; error: string } {
  return args.length === 2 && args[0] === 'current' && args[1] === '--json'
    ? { ok: true }
    : { ok: false, error: '用法: botmux actor current --json' };
}

export function normalizeActorEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CurrentActorError('current Lark actor has no verified email');
  }
  const email = value.trim().toLowerCase();
  const separator = email.indexOf('@');
  if (separator <= 0 || separator === email.length - 1 || email.indexOf('@', separator + 1) !== -1) {
    throw new CurrentActorError('current Lark actor email is invalid');
  }
  return email;
}

/**
 * Normalize a Lark `union_id` (`on_…`), the developer-scoped human identity.
 *
 * Deliberately NOT case-folded: unlike an email, a Lark id is an opaque token
 * whose case is significant, so lower-casing it would silently produce a value
 * that matches nobody. The `on_` namespace is required rather than assumed — an
 * `ou_` open_id reaching here must fail instead of being read as a canonical
 * identity it is not, because that substitution is exactly the cross-app mix-up
 * this field exists to prevent.
 */
export function normalizeUnionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CurrentActorError('current Lark actor has no union_id');
  }
  const unionId = value.trim();
  if (!unionId.startsWith('on_') || unionId.length <= 3 || /\s/.test(unionId)) {
    throw new CurrentActorError('current Lark actor union_id is invalid');
  }
  return unionId;
}

/** App-scoped ids are checked for namespace only here: what proves they belong
 *  to this app and this turn is the daemon's attestation, not this parser. */
function isNamespacedId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.length > prefix.length && value.startsWith(prefix);
}

function parentPid(pid: number, procRoot: string): number | undefined {
  if (process.platform === 'linux' || procRoot !== '/proc') {
    try {
      const raw = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      const value = Number(fields[1]);
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch { return undefined; }
  }
  const ps = ['/usr/bin/ps', '/bin/ps'].find(existsSync);
  if (!ps) return undefined;
  try {
    const value = Number(execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

function processEnvironment(pid: number, procRoot: string): Record<string, string> | undefined {
  if (process.platform !== 'linux' && procRoot === '/proc') return undefined;
  try {
    const env: Record<string, string> = {};
    for (const item of readFileSync(`${procRoot}/${pid}/environ`).toString('utf8').split('\0')) {
      const separator = item.indexOf('=');
      if (separator > 0) env[item.slice(0, separator)] = item.slice(separator + 1);
    }
    return env;
  } catch { return undefined; }
}

/**
 * A pane process is parented by the long-lived tmux server, not by the tmux
 * client that created the session. The server's kernel-held environment is a
 * launch-time snapshot: `tmux set-environment -gu` can scrub tmux's global
 * table, but cannot rewrite `/proc/<server>/environ`. Treat the real server as
 * a lineage boundary so stale routing from an older BotMux session is neither
 * trusted nor compared with the current pane's fresh routing.
 *
 * Require both the kernel process name and executable basename. A process that
 * merely changes argv/comm to look like tmux must not truncate attestation.
 */
function isTmuxServerProcess(pid: number, procRoot: string): boolean {
  try {
    const raw = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const openParen = raw.indexOf('(');
    const closeParen = raw.lastIndexOf(')');
    if (openParen < 0 || closeParen <= openParen
      || raw.slice(openParen + 1, closeParen) !== 'tmux: server') return false;
    const executable = basename(readlinkSync(`${procRoot}/${pid}/exe`)).replace(/ \(deleted\)$/, '');
    return executable === 'tmux';
  } catch {
    return false;
  }
}

/** Read routing only from an already-running BotMux CLI ancestor. A child can
 * mutate its own env but cannot rewrite its parent's kernel-held environment. */
export function resolveBotmuxAncestorContext(
  startPid = process.ppid,
  procRoot = '/proc',
): BotmuxAncestorContext {
  if (process.platform !== 'linux' && procRoot === '/proc') {
    throw new CurrentActorError('current actor ancestor attestation is unsupported');
  }
  const contexts: BotmuxAncestorContext[] = [];
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (isTmuxServerProcess(pid, procRoot)) break;
    const env = processEnvironment(pid, procRoot);
    if (!env) throw new CurrentActorError('current actor ancestor attestation failed');
    if (env.BOTMUX === '1') {
      const ipcPort = Number(env.BOTMUX_DAEMON_IPC_PORT);
      // Codex RPC tool shells intentionally inherit only a narrow BotMux env
      // (normally BOTMUX_SESSION_ID). They are descendants, not routing
      // authorities; keep walking until a complete worker/engine context is
      // found. The daemon endpoint still proves the live CLI process and turn.
      if (env.BOTMUX_SESSION_ID && env.BOTMUX_LARK_APP_ID?.startsWith('cli_')
        && Number.isSafeInteger(ipcPort) && ipcPort >= 1 && ipcPort <= 65_535) {
        contexts.push({
          sessionId: env.BOTMUX_SESSION_ID,
          larkAppId: env.BOTMUX_LARK_APP_ID,
          ipcPort,
        });
      }
    }
    const parent = parentPid(pid, procRoot);
    if (!parent) break;
    pid = parent;
  }
  if (contexts.length === 0) {
    throw new CurrentActorError('current actor ancestor attestation failed');
  }
  const nearest = contexts[0];
  const sameSession = contexts.filter(context => context.sessionId === nearest.sessionId);
  if (sameSession.some(context => (
    context.larkAppId !== nearest.larkAppId
    || context.ipcPort !== nearest.ipcPort
  ))) {
    throw new CurrentActorError('current actor ancestor attestation failed');
  }
  // A daemon restarted from another managed session can legitimately retain
  // that outer session id above the current worker. Select the nearest complete
  // session; resolveCurrentActor then binds it to the live process marker.
  return nearest;
}

/** The closed field set of `actor`. A document that grew a key is a shape this
 *  validator was not written for, and reading identity out of it would be
 *  guessing; adding one is a schema change and must bump the version, on both
 *  sides at once. */
const ACTOR_FIELDS = new Set(['canonical', 'appLocal', 'displayName', 'email']);

function isCurrentActorDocument(value: unknown): value is CurrentActorDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (document.schema !== CURRENT_ACTOR_SCHEMA || document.status !== 'verified') return false;
  // Required, not optional: a document that omits them is the older shape, and
  // a consumer that recorded `undefined` as the conversation or the turn would
  // be recording a value nobody attested. Refusing here makes the older daemon
  // say "this actor could not be verified" rather than handing back a document
  // whose locators silently do not exist.
  if (typeof document.chatId !== 'string' || document.chatId.length === 0
    || typeof document.turnId !== 'string' || document.turnId.length === 0) return false;
  const actor = document.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false;
  const fields = actor as Record<string, unknown>;
  if (Object.keys(fields).some(key => !ACTOR_FIELDS.has(key))) return false;
  const canonical = fields.canonical;
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return false;
  const canonicalFields = canonical as Record<string, unknown>;
  if (Object.keys(canonicalFields).length !== 2
    || canonicalFields.kind !== CANONICAL_ID_KIND_UNION) return false;
  // The canonical id is what verification rests on, so an absent or malformed
  // one invalidates the whole document. There is deliberately no fallback to
  // the app-local evidence or to the email: silently re-rooting identity on a
  // weaker field is the fail-open this document exists to make impossible.
  try { if (normalizeUnionId(canonicalFields.value) !== canonicalFields.value) return false; }
  catch { return false; }
  const appLocal = fields.appLocal;
  if (!appLocal || typeof appLocal !== 'object' || Array.isArray(appLocal)) return false;
  const appFields = appLocal as Record<string, unknown>;
  if (Object.keys(appFields).length !== 2
    || !isNamespacedId(appFields.larkAppId, 'cli_')
    || !isNamespacedId(appFields.openId, 'ou_')) return false;
  // Optional attributes: present means "must be well formed", absent means "the
  // tenant did not expose it". Neither carries evidence, so neither can make a
  // document invalid — but a malformed one is refused rather than published as
  // though it had been checked.
  if (fields.email !== undefined) {
    if (typeof fields.email !== 'string' || fields.email !== fields.email.trim()
      || fields.email !== fields.email.toLowerCase()) return false;
    try { if (normalizeActorEmail(fields.email) !== fields.email) return false; }
    catch { return false; }
  }
  if (fields.displayName !== undefined) {
    if (typeof fields.displayName !== 'string' || fields.displayName.length === 0
      || fields.displayName !== fields.displayName.trim()) return false;
  }
  return true;
}

/**
 * Ask the owning daemon for the current human actor. The daemon identifies the
 * HTTP client through the live loopback socket, proves that process belongs to
 * the exact live CLI/worker generation, and reads sender identity AND the
 * conversation/turn locators from its in-memory turn state. Environment values
 * are routing hints only.
 *
 * The returned document is all-or-nothing: a daemon that cannot attest the
 * actor, or that predates the locators, produces a `blocked` response rather
 * than a `verified` one. A caller may therefore treat a resolved document as
 * "this act belongs to this actor, in this conversation, on this turn".
 */
export async function resolveCurrentActor(
  options: ResolveCurrentActorOptions,
): Promise<CurrentActorDocument> {
  if (!Number.isSafeInteger(options.ipcPort) || options.ipcPort <= 0 || options.ipcPort > 65_535) {
    throw new CurrentActorError('owning BotMux daemon port is unavailable');
  }
  if (!options.sessionId || options.sessionId.length > 256) {
    throw new CurrentActorError('current BotMux session is unavailable');
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? loopbackFetchImpl)(
      `http://127.0.0.1:${options.ipcPort}${CURRENT_ACTOR_ROUTE}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: options.sessionId,
          ...(options.expectedScheduledTurnId
            ? { expectedScheduledTurnId: options.expectedScheduledTurnId }
            : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch (error) {
    throw new CurrentActorError(
      `owning BotMux daemon is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CurrentActorError('owning BotMux daemon returned an invalid actor response');
  }
  if (!response.ok || !isCurrentActorDocument(payload)) {
    throw new CurrentActorError('current BotMux actor could not be verified by the owning daemon');
  }
  return payload;
}
