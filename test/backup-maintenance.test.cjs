const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

test(
  'backup maintenance restores service after failure and only expires verified replicas',
  { skip: process.platform === 'win32' },
  async () => {
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), 'lcg-maintenance-'),
    );
    try {
      const root = path.join(temporary, 'gemini-tools'),
        bin = path.join(temporary, 'bin'),
        log = path.join(temporary, 'calls');
      const archives = path.join(root, 'backups/agent');
      await fs.mkdir(archives, { recursive: true });
      await fs.mkdir(path.join(root, 'deploy'));
      await fs.mkdir(bin);
      await fs.writeFile(path.join(root, '.images.env'), '');
      await fs.writeFile(path.join(root, 'deploy/compose.backup.yml'), '');
      const fakeDocker =
        '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [[ "$*" == *"--entrypoint node"* && "$CASE" == preflight ]]; then exit 2; fi\nif [[ "$*" == *" backup backup "* && "$CASE" == failed ]]; then exit 1; fi\n';
      await fs.writeFile(path.join(bin, 'docker'), fakeDocker, { mode: 0o700 });
      await fs.writeFile(path.join(bin, 'curl'), '#!/bin/bash\nexit 0\n', {
        mode: 0o700,
      });
      const run = (scenario) =>
        spawnSync('bash', [path.resolve('scripts/agent-backup.sh'), root], {
          env: {
            ...process.env,
            PATH: bin + ':' + process.env.PATH,
            CALL_LOG: log,
            CASE: scenario,
          },
          encoding: 'utf8',
        });
      assert.notEqual(run('preflight').status, 0);
      assert.ok(!(await fs.readFile(log, 'utf8')).includes(' stop api worker'));
      await fs.writeFile(log, '');
      assert.notEqual(run('failed').status, 0);
      assert.match(await fs.readFile(log, 'utf8'), /up -d --no-deps --wait/);
      const old = path.join(archives, 'lcg-20260901T000000Z.enc'),
        unreplicated = path.join(archives, 'lcg-20260902T000000Z.enc');
      await fs.writeFile(old, 'verified archive');
      await fs.writeFile(unreplicated, 'unreplicated archive');
      const hash = createHash('sha256')
        .update('verified archive')
        .digest('hex');
      await fs.writeFile(
        old + '.replicated',
        `${hash}  ${path.basename(old)}\n`,
      );
      const ago = new Date(Date.now() - 20 * 86400000);
      await fs.utimes(old, ago, ago);
      await fs.utimes(unreplicated, ago, ago);
      const success = run('success');
      assert.equal(success.status, 0, success.stderr);
      await assert.rejects(fs.access(old));
      await fs.access(unreplicated);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  },
);
