const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('DKIM TXT records require a valid selector and the existing parent owner', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dkim-validation-'));
  const owner = { email: 'user@example.com' };
  const txt = { type: 'TXT', value: 'v=DKIM1; p=test' };
  const write = (file, content) => writeFile(path.join(workspace, file), JSON.stringify(content));
  const git = (...args) => execFileSync('git', args, { cwd: workspace });
  const validate = (file, kind = 'ADDED_FILES') => spawnSync(process.execPath, [path.join(__dirname, '../scripts/validate-pr.js')], {
    env: { ...process.env, GITHUB_WORKSPACE: workspace, PR_AUTHOR: 'is-an-ai-org-bot[bot]',
      PR_AUTHOR_TYPE: 'Bot', GITHUB_TOKEN: '', ADDED_FILES: '', MODIFIED_FILES: '', DELETED_FILES: '', [kind]: file },
    encoding: 'utf8',
  });
  try {
    await mkdir(path.join(workspace, 'records'));
    await write('records/crag.json', { owner, record: [{ type: 'A', value: '192.0.2.1' }] });
    git('init', '--quiet');
    git('add', 'records/crag.json');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Parent registration');
    for (const name of ['zmail._domainkey.crag', 'mail.s1._domainkey.crag']) {
      const file = `records/${name}.json`;
      await write(file, { owner, record: [txt] });
      const result = validate(file);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const file = 'records/zmail._domainkey.crag.json';
    git('add', file);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'DKIM registration');
    for (const kind of ['ADDED_FILES', 'MODIFIED_FILES']) {
      await write(file, { owner: { email: 'attacker@example.com' }, record: [txt] });
      await write('records/crag.json', { owner: { email: 'attacker@example.com' }, record: [txt] });
      const result = validate(file, kind);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /same owner as an existing parent/);
    }
    await write(file, { owner, record: [{ ...txt, value: 'v=DKIM1; p=updated' }] });
    const modified = validate(file, 'MODIFIED_FILES');
    assert.equal(modified.status, 0, modified.stdout + modified.stderr);
    for (const [name, record, error] of [
      ['zmail._domainkey.missing', txt, /same owner as an existing parent/],
      ['-bad._domainkey.crag', txt, /Invalid DKIM selector/],
      ['bad_name.crag', txt, /Cannot contain underscores/],
      ['zmail._domainkey.crag', { type: 'A', value: '192.0.2.1' }, /only support TXT records/],
    ]) {
      const target = `records/${name}.json`;
      await write(target, { owner, record: [record] });
      const result = validate(target);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, error);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
