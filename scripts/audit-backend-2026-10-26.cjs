// Regression checks for the backend findings from 26 October.
const { spawnSync } = require('node:child_process')
const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--low-resource', 'backend-hardening', 'health-export', 'health-import', 'backup-restore', 'briefing'], { cwd: require('node:path').resolve(__dirname, '..'), stdio: 'inherit' })
process.exitCode = result.status ?? 1
