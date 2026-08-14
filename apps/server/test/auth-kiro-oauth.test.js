import test from 'node:test';
import assert from 'node:assert/strict';

import {
    generateCodeVerifier,
    generateCodeChallenge,
    generateState,
    generatePKCE
} from '../src/auth/kiro-oauth.js';

// --- generateCodeVerifier ---

test('generateCodeVerifier returns a non-empty string', () => {
    const v = generateCodeVerifier();
    assert.ok(typeof v === 'string');
    assert.ok(v.length > 0);
});

test('generateCodeVerifier is base64url-safe (no +, /, = chars)', () => {
    const v = generateCodeVerifier();
    assert.doesNotMatch(v, /[+/=]/);
});

test('generateCodeVerifier default output is ~43 chars (32 bytes base64url)', () => {
    const v = generateCodeVerifier();
    // 32 bytes => 43 base64url chars
    assert.ok(v.length >= 40 && v.length <= 50, `Unexpected length: ${v.length}`);
});

test('generateCodeVerifier respects custom byte length', () => {
    const v16 = generateCodeVerifier(16);
    const v64 = generateCodeVerifier(64);
    assert.ok(v16.length < v64.length, 'longer bytes should produce longer verifier');
});

test('generateCodeVerifier produces unique values across calls', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    assert.notEqual(a, b);
});

// --- generateCodeChallenge ---

test('generateCodeChallenge returns a non-empty string for a given verifier', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    assert.ok(typeof challenge === 'string');
    assert.ok(challenge.length > 0);
});

test('generateCodeChallenge is deterministic for the same verifier', () => {
    const verifier = 'test-verifier-string';
    const c1 = generateCodeChallenge(verifier);
    const c2 = generateCodeChallenge(verifier);
    assert.equal(c1, c2);
});

test('generateCodeChallenge is base64url-safe', () => {
    const challenge = generateCodeChallenge(generateCodeVerifier());
    assert.doesNotMatch(challenge, /[+/=]/);
});

test('generateCodeChallenge produces different output for different verifiers', () => {
    const c1 = generateCodeChallenge('verifier-one');
    const c2 = generateCodeChallenge('verifier-two');
    assert.notEqual(c1, c2);
});

// --- generateState ---

test('generateState returns a non-empty string', () => {
    const s = generateState();
    assert.ok(typeof s === 'string');
    assert.ok(s.length > 0);
});

test('generateState is base64url-safe', () => {
    const s = generateState();
    assert.doesNotMatch(s, /[+/=]/);
});

test('generateState produces unique values across calls', () => {
    const a = generateState();
    const b = generateState();
    assert.notEqual(a, b);
});

// --- generatePKCE ---

test('generatePKCE returns an object with codeVerifier, codeChallenge, and state', () => {
    const pkce = generatePKCE();
    assert.ok(typeof pkce.codeVerifier === 'string');
    assert.ok(typeof pkce.codeChallenge === 'string');
    assert.ok(typeof pkce.state === 'string');
});

test('generatePKCE codeChallenge is derived from codeVerifier', () => {
    const pkce = generatePKCE();
    const expected = generateCodeChallenge(pkce.codeVerifier);
    assert.equal(pkce.codeChallenge, expected);
});

test('generatePKCE all fields are non-empty', () => {
    const pkce = generatePKCE();
    assert.ok(pkce.codeVerifier.length > 0);
    assert.ok(pkce.codeChallenge.length > 0);
    assert.ok(pkce.state.length > 0);
});

test('generatePKCE produces different values each call', () => {
    const a = generatePKCE();
    const b = generatePKCE();
    assert.notEqual(a.codeVerifier, b.codeVerifier);
    assert.notEqual(a.state, b.state);
});

test('generatePKCE accepts custom byte length', () => {
    const small = generatePKCE(16);
    const large = generatePKCE(64);
    assert.ok(small.codeVerifier.length < large.codeVerifier.length);
});
