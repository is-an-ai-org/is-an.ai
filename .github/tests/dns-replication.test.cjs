const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('replication diagnostics only read and only print non-secret settings', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/config')) {
      res.end(JSON.stringify([
        { name: 'also-notify', value: '216.218.130.2' },
        { name: 'primary', value: 'yes' },
        { name: 'api-key', value: 'secret-api-key' },
        { name: 'gpgsql-password', value: 'secret-db-password' },
      ]));
    } else if (req.url.endsWith('/metadata/ALSO-NOTIFY')) {
      res.end(JSON.stringify({ kind: 'ALSO-NOTIFY', metadata: [] }));
    } else {
      res.end(JSON.stringify({ name: 'is-an.ai.', kind: 'Master', serial: 10, notified_serial: 10,
        master_tsig_key_ids: ['private-key-id'], rrsets: [{ name: 'private-record' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, '../scripts/test-pdns.js'), 'replication', 'is-an.ai.'], {
        env: { ...process.env, PDNS_API_KEY: 'test', PDNS_API_URL: `http://127.0.0.1:${server.address().port}`, PDNS_ZONE: 'is-an.ai.' },
      });
      let output = '';
      child.stdout.on('data', data => output += data);
      child.stderr.on('data', data => output += data);
      child.on('error', reject);
      child.on('exit', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(([method]) => method === 'GET'));
    assert.match(result.output, /216\.218\.130\.2/);
    assert.match(result.output, /"zone_also_notify": \[\]/);
    for (const secret of ['secret-api-key', 'secret-db-password', 'private-key-id', 'private-record']) {
      assert.equal(result.output.includes(secret), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
