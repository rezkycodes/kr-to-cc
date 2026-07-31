import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
  );
}

/** Same route table as the app, with stub pages so the shell is under test. */
function testRouter() {
  const blank = { template: '<div />' };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/dashboard' },
      { path: '/dashboard', component: blank, meta: { title: 'Monitor' } },
      { path: '/oauth/kiro', component: blank, meta: { title: 'Sign in' } },
      { path: '/config/claude', component: blank, meta: { title: 'Configure' } },
    ],
  });
}

describe('app shell', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/oauth/kiro/status')) return json({ authenticated: true });
        if (url.startsWith('/health')) return json({ status: 'ok' });
        return json({ error: { message: 'unexpected call' } }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes the three sections and marks the current one', async () => {
    const router = testRouter();
    await router.push('/config/claude');
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    const links = wrapper.findAll('nav[aria-label="Sections"] a');
    expect(links.map((link) => link.text())).toEqual(['Monitor', 'Sign in', 'Configure']);
    expect(links[2].attributes('aria-current')).toBe('page');
    expect(links[0].attributes('aria-current')).toBeUndefined();

    wrapper.unmount();
  });

  it('redirects the root to the monitor and reflects gateway health', async () => {
    const router = testRouter();
    await router.push('/');
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/dashboard');
    // Healthy gateways show the host rather than an alarm.
    expect(wrapper.get('header').text()).not.toContain('offline');

    wrapper.unmount();
  });

  it('marks the gateway offline when /health fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connection refused'))),
    );
    const router = testRouter();
    await router.push('/dashboard');
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get('header').text()).toContain('offline');

    wrapper.unmount();
  });
});
