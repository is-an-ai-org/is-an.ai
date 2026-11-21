const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const [value, ok] of [
  ['github.com', false],
  ['GitHub.com', false],
  ['raw.githubusercontent.com', false],
  ['github.io', false],
  ['octocat.github.io', true],
  ['my-project.vercel.app', true],
]) {
  test(`CNAME ${value} ${ok ? 'passes' : 'is rejected'}`, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'shared-host-'));
    try {
      await mkdir(path.join(workspace, 'records'));
      await writeFile(path.join(workspace, 'records/probe.json'), JSON.stringify({
        owner: { github_username: 'probe', email: 'probe@example.com' },
        record: [{ type: 'CNAME', value }],
      }));
      const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/validate-pr.js')], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace, PR_AUTHOR: 'is-an-ai-org-bot[bot]', PR_AUTHOR_TYPE: 'Bot', ADDED_FILES: 'records/probe.json', MODIFIED_FILES: '', DELETED_FILES: '' },
        encoding: 'utf8',
      });
      assert.equal(r.status === 0, ok, r.stdout + r.stderr);
      if (!ok) assert.match(r.stdout, /shared host/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
