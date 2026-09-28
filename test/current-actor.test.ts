import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_ID_KIND_UNION,
  CURRENT_ACTOR_SCHEMA,
  CurrentActorError,
  normalizeActorEmail,
  normalizeUnionId,
  parseCurrentActorArgs,
  resolveBotmuxAncestorContext,
  resolveCurrentActor,
} from '../src/cli/current-actor.js';

/** The two halves of a well-formed actor, as the daemon emits them. */
const CANONICAL = { kind: CANONICAL_ID_KIND_UNION, value: 'on_current' };
const APP_LOCAL = { larkAppId: 'cli_app', openId: 'ou_current' };

/** Build a document in the current shape, with any part overridable. An
 *  override set to `undefined` drops that key once the payload is serialised,
 *  which is how the "older daemon omitted it" cases below are expressed. */
function currentDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: CURRENT_ACTOR_SCHEMA,
    status: 'verified',
    actor: { canonical: { ...CANONICAL }, appLocal: { ...APP_LOCAL } },
    chatId: 'oc_chat',
    turnId: 'om_turn',
    ...overrides,
  };
}

function writeProcEnv(
  root: string,
  pid: number,
  parent: number,
  env: Record<string, string>,
  options: { comm?: string; exe?: string } = {},
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), `${pid} (${options.comm ?? 'proc'}) S ${parent} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n`);
  writeFileSync(join(dir, 'environ'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0'));
  if (options.exe) symlinkSync(options.exe, join(dir, 'exe'));
}

describe('current actor client contract', () => {
  it.skipIf(process.platform !== 'linux')('gets route hints from a consistent BotMux ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    const env = {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_app',
      BOTMUX_DAEMON_IPC_PORT: '7951',
    };
    writeProcEnv(root, 20, 10, env);
    writeProcEnv(root, 10, 1, env);
    expect(resolveBotmuxAncestorContext(20, root)).toEqual({
      sessionId: 's1', larkAppId: 'cli_app', ipcPort: 7951,
    });
  });

  it.skipIf(process.platform !== 'linux')('rejects conflicting routing for the same BotMux session', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    writeProcEnv(root, 20, 10, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    writeProcEnv(root, 10, 1, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_other', BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    expect(() => resolveBotmuxAncestorContext(20, root)).toThrow(CurrentActorError);
  });

  it.skipIf(process.platform !== 'linux')('skips a narrow tool shell and ignores an outer daemon session', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    writeProcEnv(root, 30, 20, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-current',
    });
    writeProcEnv(root, 20, 10, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-current', BOTMUX_LARK_APP_ID: 'cli_current',
      BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    writeProcEnv(root, 10, 1, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-daemon-parent', BOTMUX_LARK_APP_ID: 'cli_current',
      BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    expect(resolveBotmuxAncestorContext(30, root)).toEqual({
      sessionId: 's-current', larkAppId: 'cli_current', ipcPort: 7951,
    });
  });

  it.skipIf(process.platform !== 'linux')('stops before a shared tmux server with stale BotMux routing', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    const current = {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-current', BOTMUX_LARK_APP_ID: 'cli_current',
      BOTMUX_DAEMON_IPC_PORT: '7951',
    };
    const stale = {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's-stale', BOTMUX_LARK_APP_ID: 'cli_stale',
      BOTMUX_DAEMON_IPC_PORT: '7952',
    };
    writeProcEnv(root, 30, 20, current);
    writeProcEnv(root, 20, 10, current);
    writeProcEnv(root, 10, 5, stale, { comm: 'tmux: server', exe: '/usr/bin/tmux' });
    writeProcEnv(root, 5, 1, stale);

    expect(resolveBotmuxAncestorContext(30, root)).toEqual({
      sessionId: 's-current', larkAppId: 'cli_current', ipcPort: 7951,
    });
  });

  it.skipIf(process.platform !== 'linux')('does not trust a process merely named like a tmux server', () => {
    const root = mkdtempSync(join(tmpdir(), 'actor-env-'));
    writeProcEnv(root, 20, 10, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_app', BOTMUX_DAEMON_IPC_PORT: '7951',
    });
    writeProcEnv(root, 10, 1, {
      BOTMUX: '1', BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'cli_other', BOTMUX_DAEMON_IPC_PORT: '7951',
    }, { comm: 'tmux: server', exe: '/tmp/not-tmux' });

    expect(() => resolveBotmuxAncestorContext(20, root)).toThrow(CurrentActorError);
  });

  it('republishes the opening turn after the live CLI pid is attested', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const start = worker.indexOf('function publishLocalProcessAttestation');
    const body = worker.slice(start, worker.indexOf('/** Deliver a terminal IPC', start));
    expect(body).toContain("type: 'local_process_attestation'");
    expect(body).toContain('if (currentBotmuxTurnId) publishSandboxRelayCapability()');
  });

  it('accepts only the machine-readable current command', () => {
    expect(parseCurrentActorArgs(['current', '--json'])).toEqual({ ok: true });
    expect(parseCurrentActorArgs(['current'])).toEqual({
      ok: false,
      error: '用法: botmux actor current --json',
    });
  });

  it('accepts an exact verified daemon response and reads its canonical identity', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(currentDocument({
      actor: {
        canonical: CANONICAL, appLocal: APP_LOCAL,
        displayName: '张三', email: 'current.user@example.com',
      },
    })), { status: 200 }));
    await expect(resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({
      status: 'verified',
      actor: {
        canonical: { kind: 'union_id', value: 'on_current' },
        appLocal: { larkAppId: 'cli_app', openId: 'ou_current' },
        displayName: '张三',
        email: 'current.user@example.com',
      },
      chatId: 'oc_chat',
      turnId: 'om_turn',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:7951/api/current-actor',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 'sess-1' }) }),
    );
  });

  it('verifies an actor the tenant exposes no email or name for', async () => {
    // The canonical identity is what verification rests on. An app that cannot
    // read the email field still identifies a person, so the document is
    // complete without it — this is the coupling the change removes.
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(currentDocument()), { status: 200 },
    ));
    const document = await resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(document.actor.canonical.value).toBe('on_current');
    expect(document.actor.email).toBeUndefined();
    expect(document.actor.displayName).toBeUndefined();
  });

  it('asks the daemon to prove an exact scheduled turn when requested', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(currentDocument()), { status: 200 },
    ));
    const scheduledTurnId = 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc';

    await resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      expectedScheduledTurnId: scheduledTurnId,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:7951/api/current-actor',
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: 'sess-1', expectedScheduledTurnId: scheduledTurnId,
        }),
      }),
    );
  });

  it.each([
    // Both earlier shapes. A daemon that predates the canonical identity is
    // refused rather than read for whatever identity it happens to carry.
    [{ schema: 'botmux.current-actor.v1', status: 'verified', actor: { email: 'x@example.com' }, chatId: 'oc_chat', turnId: 'om_turn' }],
    [{ schema: 'botmux.current-actor.v2', status: 'verified', actor: { email: 'x@example.com' }, chatId: 'oc_chat', turnId: 'om_turn' }],
    [currentDocument({ status: 'blocked' })],
    [currentDocument({ actor: undefined })],
    // No fallback to a weaker field: an app-local `ou_` or an email is not a
    // canonical identity, and re-rooting on one is the fail-open this document
    // exists to make impossible.
    [currentDocument({ actor: { appLocal: APP_LOCAL, email: 'x@example.com' } })],
    [currentDocument({ actor: { canonical: { kind: 'open_id', value: 'ou_x' }, appLocal: APP_LOCAL } })],
    [currentDocument({ actor: { canonical: { kind: 'union_id', value: 'ou_x' }, appLocal: APP_LOCAL } })],
    [currentDocument({ actor: { canonical: { kind: 'union_id', value: 'on_ current' }, appLocal: APP_LOCAL } })],
    [currentDocument({ actor: { canonical: { kind: 'union_id', value: 'on_' }, appLocal: APP_LOCAL } })],
    [currentDocument({ actor: { canonical: { kind: 'union_id' }, appLocal: APP_LOCAL } })],
    [currentDocument({ actor: { canonical: { kind: 'union_id', value: 'on_current', extra: 1 }, appLocal: APP_LOCAL } })],
    [currentDocument({ actor: { canonical: CANONICAL } })],
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: { larkAppId: 'cli_app', openId: 'on_x' } } })],
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: { larkAppId: 'app_x', openId: 'ou_current' } } })],
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: { larkAppId: 'cli_app' } } })],
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: { larkAppId: 'cli_app', openId: 'ou_current', extra: 1 } } })],
    // A closed field set: a key this validator was not written for is a shape
    // change to be refused, not an attribute to skip past.
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: APP_LOCAL, username: 'x' } })],
    // Attributes are optional but never unvalidated: absent means the tenant
    // did not expose it, malformed means the document is refused.
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: APP_LOCAL, email: 'X@example.com' } })],
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: APP_LOCAL, email: 'not-an-email' } })],
    [currentDocument({ actor: { canonical: CANONICAL, appLocal: APP_LOCAL, displayName: '' } })],
    // A daemon that predates the locators must fail closed rather than hand
    // back a verified actor with nothing to bind it to a conversation or turn.
    [currentDocument({ chatId: undefined })],
    [currentDocument({ chatId: '' })],
    [currentDocument({ turnId: '' })],
    [currentDocument({ turnId: undefined })],
    [currentDocument({ chatId: 1 })],
  ])('rejects an invalid daemon document: %j', async (payload) => {
    await expect(resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    })).rejects.toThrow(CurrentActorError);
  });

  it('fails closed when the daemon refuses the request', async () => {
    await expect(resolveCurrentActor({
      ipcPort: 7951,
      sessionId: 'sess-1',
      fetchImpl: vi.fn(async () => new Response('{}', { status: 403 })) as typeof fetch,
    })).rejects.toThrow(CurrentActorError);
  });

  it.each([undefined, '', 'not-an-email', '@example.com', 'a@b@c'])(
    'normalizer rejects an invalid email: %s',
    (email) => expect(() => normalizeActorEmail(email)).toThrow(CurrentActorError),
  );

  it('normalizes an actor email without enforcing a tenant domain', () => {
    expect(normalizeActorEmail(' Current.User@Example.COM ')).toBe('current.user@example.com');
  });

  it.each([undefined, null, 42, '', '   ', 'ou_x', 'on_', 'on_a b', 'on_\n'])(
    'union normalizer rejects a value that is not an id: %s',
    (value) => expect(() => normalizeUnionId(value)).toThrow(CurrentActorError),
  );

  it('normalizes a union_id without folding its case', () => {
    // A Lark id is an opaque, case-significant token: folding it the way an
    // email is folded would yield a value that matches nobody.
    expect(normalizeUnionId(' on_AbC123 ')).toBe('on_AbC123');
  });
});
