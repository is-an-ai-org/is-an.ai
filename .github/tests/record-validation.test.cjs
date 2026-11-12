const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('PR validation rejects duplicate records in additions and modifications', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dns-record-validation-'));
  const file = 'records/example.json';
  const txt = { type: 'TXT', value: 'kata-verify=duplicate' };
  const write = records => writeFile(path.join(workspace, file), JSON.stringify({
    owner: { email: 'user@example.com' }, record: records,
  }));
  const git = (...args) => execFileSync('git', args, { cwd: workspace });
  const validate = files => spawnSync(process.execPath, [path.join(__dirname, '../scripts/validate-pr.js')], {
    env: { ...process.env, GITHUB_WORKSPACE: workspace, PR_AUTHOR: 'is-an-ai-org-bot[bot]',
      PR_AUTHOR_TYPE: 'Bot', GITHUB_TOKEN: '', ADDED_FILES: '', MODIFIED_FILES: '', DELETED_FILES: '', ...files },
    encoding: 'utf8',
  });
  try {
    await mkdir(path.join(workspace, 'records'));
    await write([txt]);
    git('init', '--quiet');
    git('add', file);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Initial record');
    for (const records of [
      [txt, txt],
      [txt, { ...txt, type: 'txt' }],
      [{ type: 'MX', value: { priority: 10, exchange: 'mail.example.com' } },
        { type: 'MX', value: { exchange: 'mail.example.com', priority: 10 } }],
    ]) {
      await write(records);
      for (const files of [{ ADDED_FILES: file }, { MODIFIED_FILES: file }]) {
        const result = validate(files);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /Record 2: Duplicate DNS record/);
      }
    }
    await write([txt, { ...txt, value: 'other' }]);
    const result = validate({ MODIFIED_FILES: file });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
