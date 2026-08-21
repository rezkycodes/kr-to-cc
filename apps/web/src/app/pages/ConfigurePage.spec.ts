import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ConfigurePage from './ConfigurePage.vue';

const state = {
  settingsPath: '/home/dev/.claude/settings.json',
  exists: true,
  error: null,
  current: { baseUrl: 'http://localhost:9999/v1', authToken: 'dummy' },
  models: ['claude-opus-4-8', 'claude-sonnet-4-5'],
  suggestedBaseUrl: 'http://localhost:4985/v1',
  pointsHere: false,
  baseUrlIssue: 'Points at http://localhost:9999, not this gateway.',
  defaults: {
    baseUrl: 'http://localhost:4985/v1',
    authToken: 'dummy',
    opusModel: 'claude-opus-4-8',
    sonnetModel: 'claude-sonnet-4-5',
    haikuModel: 'claude-haiku-4-5',
    subagentModel: 'claude-sonnet-4-5',
  },
};

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
    if (url.startsWith('/config/claude/state')) return json(state);
    return json({ error: { message: 'unexpected call' } }, 404);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('ConfigurePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('always proposes the endpoint of the proxy serving the page', async () => {
    stubFetch();
    const wrapper = mount(ConfigurePage);
    await flushPromises();

    expect((wrapper.get('#base-url').element as HTMLInputElement).value).toBe(
      'http://localhost:4985/v1',
    );
    // The stale value in settings.json is reported, not adopted, and explained.
    expect(wrapper.text()).toContain('http://localhost:9999/v1');
    expect(wrapper.text()).toContain('not pointing here');
    expect(wrapper.text()).toContain('not this gateway');

    wrapper.unmount();
  });

  it('reports connected when settings.json already reaches this gateway', async () => {
    // The bare origin is accepted too: the server absorbs a repeated version segment.
    stubFetch({
      '/config/claude/state': () =>
        json({
          ...state,
          current: { baseUrl: 'http://localhost:4985', authToken: 'dummy' },
          pointsHere: true,
          baseUrlIssue: null,
        }),
    });
    const wrapper = mount(ConfigurePage);
    await flushPromises();

    expect(wrapper.text()).toContain('connected');
    expect(wrapper.text()).not.toContain('not pointing here');

    wrapper.unmount();
  });

  it('previews the exact env block that will be merged', async () => {
    stubFetch();
    const wrapper = mount(ConfigurePage);
    await flushPromises();

    await wrapper.get('#opusModel').setValue('claude-opus-5');
    const preview = wrapper.get('pre').text();

    expect(preview).toContain('"ANTHROPIC_BASE_URL": "http://localhost:4985/v1"');
    expect(preview).toContain('"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5"');
    expect(preview).toContain('"CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-5"');

    wrapper.unmount();
  });

  it('saves the form and confirms where it landed', async () => {
    const fetchMock = stubFetch({
      '/config/claude/apply': () =>
        json({
          success: true,
          settingsPath: '/home/dev/.claude/settings.json',
          backupPath: '/home/dev/.claude/settings.json.2026-07-31.bak',
        }),
    });
    const wrapper = mount(ConfigurePage);
    await flushPromises();

    await wrapper.get('[data-slot="button"]').trigger('click');
    await flushPromises();

    const applyCall = fetchMock.mock.calls.find(([url]) => String(url) === '/config/claude/apply');
    expect(applyCall).toBeDefined();
    expect(JSON.parse(String(applyCall?.[1]?.body)).baseUrl).toBe('http://localhost:4985/v1');
    expect(wrapper.text()).toContain('backup settings.json.2026-07-31.bak');

    wrapper.unmount();
  });

});
