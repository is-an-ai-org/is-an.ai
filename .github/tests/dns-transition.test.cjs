const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');

const name = 'tree-vision.is-an.ai.';
const target = 'tree-vision.netlify.app';
const cname = { type: 'CNAME', value: target };
const txt = { type: 'TXT', value: '1120448' };
const rrset = (type, content) => ({ name, type, ttl: 300, records: [{ content, disabled: false }] });

for (const script of ['update-pdns-dns', 'sync-pdns-dns']) {
  for (const [label, initial, records, expected] of [
    ['add TXT to CNAME', [rrset('CNAME', target + '.')], [cname, txt], ['ALIAS', 'TXT']],
    ['create mixed records', [], [cname, txt], ['ALIAS', 'TXT']],
    ['remove TXT from ALIAS', [rrset('ALIAS', target + '.'), rrset('TXT', '"1120448"')], [cname], ['CNAME']],
    ['keep existing ALIAS', [rrset('ALIAS', target + '.'), rrset('TXT', '"1120448"')], [cname, txt], ['ALIAS', 'TXT']],
    ['replace CNAME with IP', [rrset('CNAME', target + '.')], [cname, { type: 'A', value: '192.0.2.1' }], ['A']],
  ]) {
    test(`${script}: ${label}`, async () => {
      const workspace = await mkdtemp(path.join(tmpdir(), 'dns-transition-'));
      let state = [...initial, { name: 'is-an.ai.', type: 'SOA', ttl: 3600,
        records: [{ content: 'ns1.is-an.ai. hostmaster.is-an.ai. 2026092104 10800 3600 604800 300', disabled: false }] }];
      const patches = [];
      const server = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          res.end(JSON.stringify({ rrsets: state }));
          return;
        }
        if (req.method === 'PATCH') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const changes = JSON.parse(body).rrsets;
          patches.push(changes);
          const next = new Map(state.map(r => [r.name + r.type, r]));
          for (const r of changes) {
            const key = r.name + r.type;
            if (r.changetype === 'DELETE') next.delete(key);
            else {
              const conflict = [...next.values()].some(old => old.name === r.name && old.type !== r.type && (old.type === 'CNAME' || r.type === 'CNAME'));
              if (conflict) {
                res.statusCode = 422;
                res.end(JSON.stringify({ error: 'Conflicts with pre-existing RRset' }));
                return;
              }
              next.set(key, r);
            }
          }
          state = [...next.values()];
        }
        res.end('{}');
      });
      try {
        await mkdir(path.join(workspace, 'records'));
        await writeFile(path.join(workspace, 'records/Tree-Vision.json'), JSON.stringify({ record: records }));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const run = () => new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(__dirname, `../scripts/${script}.js`)], {
            env: { ...process.env, PDNS_API_URL: `http://127.0.0.1:${server.address().port}`, PDNS_API_KEY: 'test', PDNS_ZONE: 'is-an.ai.', GITHUB_WORKSPACE: workspace, MODIFIED_FILES: 'records/Tree-Vision.json', ADDED_FILES: '', DELETED_FILES: '', DRY_RUN: 'false' },
          });
          let output = '';
          child.stdout.on('data', data => output += data);
          child.stderr.on('data', data => output += data);
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
        });
        await run();
        assert.deepEqual(state.filter(r => r.name === name).map(r => r.type).sort(), expected.sort());
        if (script === 'sync-pdns-dns') {
          patches.length = 0;
          await run();
          assert.equal(patches.length, 0, 'second full sync must have no changes');
        }
      } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
}
