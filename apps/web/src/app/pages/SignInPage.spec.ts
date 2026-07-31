import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SignInPage from './SignInPage.vue';

const sources = [
  {
    id: 'kiro-cli',
    label: 'Kiro CLI (database)',
    provider: 'google',
    authType: 'social' as const,
    expiresAt: '2026-07-31T14:00:00.000Z',
    expired: false,
    hasProfileArn: true,
  },
];

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function stubFetch(overrides: Record<string, () => Promise<Response>> = {}) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) return handler();
    }
    if (url.startsWith('/oauth/kiro/status')) return json({ authenticated: false });
    if (url.startsWith('/oauth/kiro/sources')) return json({ sources });
    return json({ error: { message: 'unexpected call' } }, 404);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('SignInPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports the current credential state and lists local sources', async () => {
    stubFetch();
    const wrapper = mount(SignInPage);
    await flushPromises();

    expect(wrapper.text()).toContain('not signed in');
    expect(wrapper.text()).toContain('Kiro CLI (database)');
    expect(wrapper.text()).toContain('google · social');
    expect(wrapper.text()).toContain('valid');

    wrapper.unmount();
  });

  it('imports a detected credential and re-reads status', async () => {
    const fetchMock = stubFetch({
      '/oauth/kiro/auto-import': () => json({ success: true, label: 'Kiro CLI', email: 'dev@example.com' }),
    });
    const wrapper = mount(SignInPage);
    await flushPromises();

    await wrapper.get('ul button').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/oauth/kiro/auto-import')).toBe(true);
    expect(wrapper.text()).toContain('Imported from Kiro CLI as dev@example.com.');

    wrapper.unmount();
  });

  it('reports why a pasted refresh token was rejected', async () => {
    stubFetch({
      '/oauth/kiro/import': () => json({ success: false, error: 'Refresh token expired.' }, 400),
    });
    const wrapper = mount(SignInPage);
    await flushPromises();

    await wrapper.get('#refresh-token').setValue('some-token');
    await wrapper.get('[aria-labelledby="token-heading"] button').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Refresh token expired.');

    wrapper.unmount();
  });

  it('asks for a token before calling the import endpoint', async () => {
    const fetchMock = stubFetch();
    const wrapper = mount(SignInPage);
    await flushPromises();

    await wrapper.get('[aria-labelledby="token-heading"] button').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Enter a refresh token.');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/oauth/kiro/import')).toBe(false);

    wrapper.unmount();
  });
});
