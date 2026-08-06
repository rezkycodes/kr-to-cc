import { createRouter, createWebHistory } from 'vue-router';

/**
 * Paths mirror the server routes they replace, so existing links, bookmarks, and
 * the README stay correct. Each of these is also served by Express (see
 * apps/server/src/routes/web-app.routes.js) for a hard refresh or deep link.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    {
      path: '/dashboard',
      name: 'monitor',
      component: () => import('./pages/DashboardPage.vue'),
      meta: { title: 'Monitor' },
    },
    {
      path: '/oauth/kiro',
      name: 'sign-in',
      component: () => import('./pages/SignInPage.vue'),
      meta: { title: 'Sign in' },
    },
    {
      path: '/providers',
      name: 'providers',
      component: () => import('./pages/ProvidersPage.vue'),
      meta: { title: 'Providers' },
    },
    {
      path: '/combos',
      name: 'combos',
      component: () => import('./pages/CombosPage.vue'),
      meta: { title: 'Combos' },
    },
    {
      path: '/config/claude',
      name: 'configure',
      component: () => import('./pages/ConfigurePage.vue'),
      meta: { title: 'Configure' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

router.afterEach((to) => {
  const title = (to.meta.title as string | undefined) ?? 'Gateway';
  document.title = `${title} · Kiro → Claude`;
});

export default router;
