import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveVerifiedUserIdentity: vi.fn() }));
import { canonicalJson, signApproval, validateGrant } from '../src/im/lark/serveros-delegation.js';

describe('ServerOS signed approval', () => {
  const grant = { grant_ref: 'grant:example', valid_from: '2026-10-06T00:00:00Z',
    expires_at: '2026-10-08T00:00:00Z', projects: ['example'], items: ['EX-0001'],
    actions: ['research'], scope_digests: { 'EX-0001': 'a'.repeat(64) },
    budget: { wall_seconds: 300, max_attempts: 2, max_output_bytes: 4096, exhausted: false } };

  it('binds exact scope, node, actual card and resolved human into one verifiable signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const binding = { provider_id: 'provider:botmux-human-control', key_id: 'test-key',
      audience: 'device:test', key: privateKey };
    const event = { askId: 'ask-1', larkAppId: 'app-1', by: 'ou_owner',
      messageId: 'om_card', observedAt: '2026-10-06T00:01:00Z' };
    const evidence = signApproval(binding, grant, event, { chatId: 'oc_test', rootMessageId: null }, 'on_human');
    const valid = () => verify(null, Buffer.from(canonicalJson(evidence.payload)), publicKey,
      Buffer.from(evidence.signature, 'base64'));
    expect(valid()).toBe(true);
    expect(evidence.payload.actor_report.actor_ref).toBe('feishu:union:on_human');
    expect(evidence.payload.actor_report.message_ref).toBe('om_card/ask/ask-1');
    evidence.payload.audience = 'device:other';
    expect(valid()).toBe(false);
  });

  it('freezes the proposal and rejects caller authority, expired or empty scopes before asking', () => {
    const now = Date.parse('2026-10-06T00:01:00Z');
    const copy = validateGrant(grant, now);
    expect(copy).toEqual(grant);
    expect(copy).not.toBe(grant);
    expect(() => validateGrant({ ...grant, actor_ref: 'human:self' }, now)).toThrow('unsupported');
    expect(() => validateGrant({ ...grant, items: [], covers: [] }, now)).toThrow('scope');
    expect(() => validateGrant(grant, Date.parse('2026-11-01T00:00:00Z'))).toThrow('window');
    expect(canonicalJson({ z: '中文', a: { y: 2, x: true } })).toBe('{"a":{"x":true,"y":2},"z":"中文"}');
  });
});
