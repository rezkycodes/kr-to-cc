#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json for version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
kiro-to-claude v${packageJson.version}

Proxy server for using Kiro's Claude models with Claude Code CLI.

USAGE:
  kiro-to-claude <command> [options]

COMMANDS:
  start                 Start the proxy server (default port: 4000)

OPTIONS:
  --help, -h            Show this help message
  --version, -v         Show version number
  --debug               Enable debug logging

ENVIRONMENT:
  PORT                  Server port (default: 4000)

EXAMPLES:
  kiro-to-claude start
  PORT=4000 kiro-to-claude start
  kiro-to-claude start --debug

PREREQUISITES:
  - Kiro CLI must be installed and authenticated
  - Run "kiro auth" to authenticate with AWS

CONFIGURATION:
  Claude Code CLI (~/.claude/settings.json):
    {
      "env": {
        "ANTHROPIC_BASE_URL": "http://localhost:4000",
        "ANTHROPIC_API_KEY": "dummy"
      }
    }
`);
}

function showVersion() {
  console.log(packageJson.version);
}

async function main() {
  // Handle flags
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  // Handle commands
  switch (command) {
    case 'start':
    case undefined:
      // Default to starting the server
      await import('../apps/server/src/index.js');
      break;

    case 'help':
      showHelp();
      break;

    case 'version':
      showVersion();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "kiro-to-claude --help" for usage information.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
