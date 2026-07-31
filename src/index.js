/**
 * Kiro to Claude
 * Entry point - starts the proxy server
 */

import app from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || process.env.DEBUG === 'true';

// Initialize logger
logger.setDebug(isDebug);

if (isDebug) {
    logger.debug('Debug mode enabled');
}

const PORT = process.env.PORT || DEFAULT_PORT;
const HOST = process.env.HOST || '127.0.0.1';

/**
 * Render a fixed-width box banner. Handles alignment automatically so lines
 * never break the borders regardless of port length or content.
 * @param {Array<string|{sep:true}|{center:string}>} lines
 * @param {number} inner - inner content width
 * @returns {string}
 */
function renderBanner(lines, inner = 64) {
    const top = `╔${'═'.repeat(inner)}╗`;
    const bottom = `╚${'═'.repeat(inner)}╝`;
    const sep = `╠${'═'.repeat(inner)}╣`;
    const out = [top];
    for (const line of lines) {
        if (line && line.sep) {
            out.push(sep);
        } else if (line && typeof line === 'object' && 'center' in line) {
            const text = line.center;
            const total = inner - text.length;
            const left = Math.max(0, Math.floor(total / 2));
            const right = Math.max(0, inner - text.length - left);
            out.push(`║${' '.repeat(left)}${text}${' '.repeat(right)}║`);
        } else {
            const text = `  ${line || ''}`;
            const padded = text.length > inner ? text.slice(0, inner) : text + ' '.repeat(inner - text.length);
            out.push(`║${padded}║`);
        }
    }
    out.push(bottom);
    return out.join('\n');
}

app.listen(PORT, HOST, () => {
    const displayHost = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST;
    const base = `http://${displayHost}:${PORT}`;
    logger.log('\n' + renderBanner([
        { center: 'Kiro to Claude Server' },
        { sep: true },
        '',
        `  Server running at: ${base}`,
        '',
        '  Control:',
        '    --debug            Enable debug logging',
        '    Ctrl+C             Stop server',
        '',
        '  API endpoints:',
        '    POST /v1/messages              Anthropic Messages API',
        '    GET  /v1/models                List available models',
        '    GET  /v1/models/check          Probe which models are active',
        '    POST /v1/messages/count_tokens Estimate token count',
        '    GET  /health                   Health check',
        '',
        '  Web UIs (open in a browser):',
        `    ${base}/oauth/kiro`,
        '        -> Sign in / import Kiro token',
        `    ${base}/config/claude`,
        '        -> Configure Claude Code',
        '',
        '  Features:',
        '    - Auto token refresh (stays signed in until you log out)',
        '    - OAuth login + auto-import from Kiro IDE / CLI',
        '    - 16 models incl. Opus 5/4.8, Sonnet 5, open-weight',
        '',
        '  Quick start with Claude Code:',
        `    1) Open ${base}/config/claude and click Apply`,
        '    2) Restart Claude Code, then run: claude',
        '',
        '    Or set manually:',
        `      export ANTHROPIC_BASE_URL=${base}`,
        '      export ANTHROPIC_API_KEY=dummy',
        '',
        '  Prerequisites:',
        '    - Sign in via /oauth/kiro, or run "kiro auth"',
        '',
    ], 70) + '\n');

    logger.success(`Server started successfully on port ${PORT}`);
    logger.info(`Sign-in / import UI:  ${base}/oauth/kiro`);
    logger.info(`Claude Code config:   ${base}/config/claude`);
    if (isDebug) {
        logger.warn('Running in DEBUG mode - verbose logs enabled');
    }
});
