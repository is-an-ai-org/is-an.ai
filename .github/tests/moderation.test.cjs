const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('PR validation protects moderator state and reserves suspended names', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dns-moderation-'));
  const registered = 'records/example.json';
  const duplicate = 'records/Example.json';
  const addition = 'records/another.json';
  const record = { owner: { email: 'user@example.com' }, record: [{ type: 'A', value: '192.0.2.1' }] };
  const git = (...args) => execFileSync('git', args, { cwd: workspace });

  try {
    await mkdir(path.join(workspace, 'records'));
    await writeFile(path.join(workspace, registered), JSON.stringify({ ...record, suspended: true }));
    git('init', '--quiet');
    git('add', registered);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Create record');
    await writeFile(path.join(workspace, registered), JSON.stringify(record));
    await writeFile(path.join(workspace, addition), JSON.stringify({ ...record, suspended: true }));

    const validate = (files) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/validate-pr.js')], {
      cwd: workspace,
      encoding: 'utf-8',
      env: { ...process.env, GITHUB_WORKSPACE: workspace, PR_AUTHOR_TYPE: 'Bot', ADDED_FILES: '', MODIFIED_FILES: '', DELETED_FILES: '', ...files },
    });

    for (const [files, error] of [
      [{ MODIFIED_FILES: registered }, /Suspended records can only be changed by moderators/],
      [{ DELETED_FILES: registered }, /Suspended records can only be removed by moderators/],
      [{ ADDED_FILES: duplicate }, /A record with this name already exists/],
      [{ ADDED_FILES: addition }, /Only moderators can set a suspension/],
    ]) {
      const result = validate(files);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout + result.stderr, error);
    }
    await writeFile(path.join(workspace, addition), JSON.stringify(record));
    assert.equal(validate({ ADDED_FILES: addition }).status, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
