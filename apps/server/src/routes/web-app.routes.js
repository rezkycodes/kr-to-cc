import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const webBuildDirectory = fileURLToPath(new URL('../../../../dist/apps/web/', import.meta.url));
const webIndexPath = join(webBuildDirectory, 'index.html');
const router = express.Router();

const immutableStaticOptions = {
    fallthrough: true,
    immutable: true,
    maxAge: '1y'
};

// Keep the production surface narrow so no frontend catch-all can shadow
// OAuth, configuration, telemetry, health, or Anthropic-compatible API routes.
router.use('/assets', express.static(join(webBuildDirectory, 'assets'), immutableStaticOptions));
router.use('/geist', express.static(join(webBuildDirectory, 'geist'), immutableStaticOptions));

// Every route the SPA owns, listed explicitly. Sibling paths under the same
// prefixes (/oauth/kiro/status, /config/claude/state, …) stay with their JSON
// routers, and each entry falls through to the server-rendered page when the
// frontend has not been built.
const APP_ROUTES = ['/', '/dashboard', '/oauth/kiro', '/config/claude', '/combos', '/providers', '/usage'];

router.get(APP_ROUTES, (req, res, next) => {
    if (!existsSync(webIndexPath)) return next();

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
    );
    return res.sendFile(webIndexPath);
});

export function hasWebAppBuild() {
    return existsSync(webIndexPath);
}

export { webBuildDirectory, webIndexPath };
export default router;
