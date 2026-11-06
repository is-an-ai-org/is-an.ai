const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Resolver } = require('node:dns/promises');
const timers = require('node:timers/promises');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { verifyDns, notifySecondaries } = require('../scripts/verify-pdns.js');

function fixture(t, options = {}) {
  const calls = { get: 0, put: [], servers: new Set(), sleeps: 0 };
  const record = { name: 'www.is-an.ai.', type: 'A', records: [{ content: '192.0.2.10', disabled: false }] };
  const data = options.data || { serial: 10, rrsets: [record] };
  const client = {
    get: async () => {
      calls.get++;
      return { data: options.load ? options.load(calls.get) : data };
    },
    put: async (...args) => { calls.put.push(args); },
  };
  const number = resolver => Number(resolver.getServers()[0].split('.').at(-1));
  t.mock.method(console, 'log', () => {});
  t.mock.method(timers, 'setTimeout', async () => { calls.sleeps++; });
  t.mock.method(Resolver.prototype, 'resolve4', async function (name) {
    const ns = name.match(/^ns([1-5])\.he\.net$/);
    if (ns) return ['198.51.100.' + ns[1]];
    const n = number(this);
    calls.servers.add(n);
    return options.answer ? options.answer(n, calls.get) : ['192.0.2.10'];
  });
  t.mock.method(Resolver.prototype, 'resolveSoa', async function () {
    const n = number(this);
    return { serial: options.serial ? options.serial(n, calls.get) : data.serial };
  });
  return { calls, client, data };
}

test('verification queries every public nameserver and never modifies PowerDNS', async t => {
  const { client, calls, data } = fixture(t);
  const before = structuredClone(data);
  await verifyDns(client, 'is-an.ai.', 'www.is-an.ai', false);
  assert.deepEqual([...calls.servers].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.put, []);
  assert.equal(calls.sleeps, 0);
  assert.deepEqual(data, before);
});

test('recovery only sends a bodyless NOTIFY and verifies unchanged records and serial', async t => {
  const { client, calls, data } = fixture(t);
  const before = structuredClone(data);
  await verifyDns(client, 'is-an.ai', 'www.is-an.ai.', true);
  assert.deepEqual(calls.put, [['/api/v1/servers/localhost/zones/is-an.ai./notify']]);
  assert.deepEqual(data, before);
  assert.equal(calls.servers.size, 5);
});

test('NOTIFY errors fail without exposing the Axios request configuration', async () => {
  const failure = new Error('Request failed with status code 403');
  failure.config = { headers: { 'X-API-Key': 'private-key-must-not-appear' } };
  await assert.rejects(notifySecondaries({ put: async () => { throw failure; } }, 'is-an.ai.'), error => {
    assert.match(error.message, /PowerDNS NOTIFY failed/);
    assert.equal(String(error).includes('private-key-must-not-appear'), false);
    assert.equal(error.config, undefined);
    return true;
  });
});

test('HE repair preserves existing metadata and records, persists the collector, then notifies', async t => {
  const { client, calls, data } = fixture(t);
  const snapshot = structuredClone(data);
  let metadata = ['192.0.2.53'];
  const load = client.get;
  client.get = async url => url.endsWith('/metadata/ALSO-NOTIFY') ? { data: { metadata } } : load();
  client.put = async (...args) => {
    calls.put.push(args);
    if (args[0].endsWith('/metadata/ALSO-NOTIFY')) metadata = args[1].metadata;
  };
  await verifyDns(client, 'is-an.ai.', 'www.is-an.ai', 'repair-he-notify');
  assert.deepEqual(calls.put, [
    ['/api/v1/servers/localhost/zones/is-an.ai./metadata/ALSO-NOTIFY', { kind: 'ALSO-NOTIFY', metadata: ['192.0.2.53', '216.218.133.2'] }],
    ['/api/v1/servers/localhost/zones/is-an.ai./notify'],
  ]);
  assert.deepEqual(data, snapshot);
  calls.put.length = 0;
  await verifyDns(client, 'is-an.ai', 'www.is-an.ai', 'repair-he-notify');
  assert.deepEqual(calls.put, [['/api/v1/servers/localhost/zones/is-an.ai./notify']]);
});

test('invalid notification metadata stops repair without writing or notifying', async t => {
  const { client, calls } = fixture(t);
  const load = client.get;
  client.get = async url => url.endsWith('/metadata/ALSO-NOTIFY') ? { data: { metadata: [null] } } : load();
  await assert.rejects(verifyDns(client, 'is-an.ai', 'www.is-an.ai', 'repair-he-notify'), /invalid ALSO-NOTIFY/);
  assert.deepEqual(calls.put, []);
});

test('explicit serial advance only replaces the SOA serial and verifies the new snapshot', async t => {
  const { client, calls, data } = fixture(t);
  const records = structuredClone(data.rrsets);
  const soa = { name: 'is-an.ai.', type: 'SOA', ttl: 7200,
    records: [{ content: 'primary.example. hostmaster.example. 10 111 222 333 444', disabled: false }] };
  const load = client.get;
  client.get = async (url, options) => {
    if (url.endsWith('/metadata/ALSO-NOTIFY')) return { data: { metadata: ['216.218.133.2'] } };
    if (options.params.rrset_type === 'SOA') return { data: { serial: data.serial, rrsets: [soa] } };
    return load();
  };
  const patches = [];
  client.patch = async (...args) => {
    patches.push(args);
    data.serial = Number(args[1].rrsets[0].records[0].content.split(' ')[2]);
  };
  await verifyDns(client, 'is-an.ai', 'www.is-an.ai', 'advance-serial');
  assert.deepEqual(patches, [['/api/v1/servers/localhost/zones/is-an.ai.', { rrsets: [{
    name: 'is-an.ai.', type: 'SOA', ttl: 7200, changetype: 'REPLACE',
    records: [{ content: 'primary.example. hostmaster.example. 11 111 222 333 444', disabled: false }],
  }] }]]);
  assert.equal(data.serial, 11);
  assert.deepEqual(data.rrsets, records);
  assert.deepEqual(calls.put, [['/api/v1/servers/localhost/zones/is-an.ai./notify']]);
});

test('an invalid or overflowing SOA cannot be advanced', async t => {
  const { client, calls } = fixture(t);
  const load = client.get;
  let serial = 10;
  let content = 'primary.example. hostmaster.example. 9 111 222 333 444';
  client.get = async (url, options) => {
    if (url.endsWith('/metadata/ALSO-NOTIFY')) return { data: { metadata: ['216.218.133.2'] } };
    if (options.params.rrset_type === 'SOA') return { data: { serial, rrsets: [{ name: 'is-an.ai.', type: 'SOA', ttl: 3600, records: [{ content, disabled: false }] }] } };
    return load();
  };
  let patches = 0;
  client.patch = async () => { patches++; };
  await assert.rejects(verifyDns(client, 'is-an.ai', 'www.is-an.ai', 'advance-serial'), /Cannot safely advance/);
  serial = 0xffffffff;
  content = 'primary.example. hostmaster.example. 4294967295 111 222 333 444';
  await assert.rejects(verifyDns(client, 'is-an.ai', 'www.is-an.ai', 'advance-serial'), /Cannot safely advance/);
  assert.equal(patches, 0);
  assert.deepEqual(calls.put, []);
});

test('stale serials and missing answers fail after a bounded retry window', async t => {
  const { client, calls } = fixture(t, {
    serial: n => n === 2 ? 9 : 10,
    answer: n => { if (n === 4) throw new Error('ENOTFOUND'); return ['192.0.2.10']; },
  });
  await assert.rejects(verifyDns(client, 'is-an.ai', 'www.is-an.ai', false), error => {
    assert.match(error.message, /ns2.he.net: serial 9/);
    assert.match(error.message, /ns4.he.net: ENOTFOUND/);
    return true;
  });
  assert.equal(calls.get, 60);
  assert.equal(calls.sleeps, 59);
  assert.deepEqual(calls.put, []);
});

test('matching SOA serial alone does not hide an incorrect record', async t => {
  const { client } = fixture(t, { answer: n => [n === 3 ? '192.0.2.99' : '192.0.2.10'] });
  await assert.rejects(verifyDns(client, 'is-an.ai', 'www.is-an.ai', false), /ns3.he.net: A www.is-an.ai differs/);
});

test('verification refreshes its snapshot when another deployment advances the primary', async t => {
  const { client, calls } = fixture(t, {
    load: n => ({ serial: n === 1 ? 10 : 11, rrsets: [{ name: 'www.is-an.ai.', type: 'A', records: [{ content: n === 1 ? '192.0.2.10' : '192.0.2.11', disabled: false }] }] }),
    serial: () => 11,
    answer: () => ['192.0.2.11'],
  });
  await verifyDns(client, 'is-an.ai', 'www.is-an.ai', false);
  assert.equal(calls.get, 2);
  assert.equal(calls.sleeps, 1);
});

test('invalid or unavailable probes cannot trigger a recovery NOTIFY', async t => {
  const { client, calls } = fixture(t);
  for (const name of ['evil.example', 'is-an.ai.evil.example', 'a..is-an.ai', '-bad.is-an.ai']) {
    await assert.rejects(verifyDns(client, 'is-an.ai', name, true));
  }
  await assert.rejects(verifyDns(client, 'is-an.ai', 'missing.is-an.ai', true), /enabled A, AAAA, or CNAME/);
  assert.deepEqual(calls.put, []);
});

test('invalid primary metadata cannot trigger a recovery NOTIFY', async t => {
  const { client, calls } = fixture(t, { data: { serial: -1, rrsets: [] } });
  await assert.rejects(verifyDns(client, 'is-an.ai', 'www.is-an.ai', true), /invalid zone snapshot/);
  assert.deepEqual(calls.put, []);
});

test('CLI rejects a dry-run recovery before contacting PowerDNS', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/verify-pdns.js')], {
    env: { ...process.env, PDNS_API_KEY: 'private-test-key', PDNS_API_URL: 'http://127.0.0.1:1', PDNS_ZONE: 'is-an.ai.', NOTIFY_ONLY: 'true', DRY_RUN: 'true' },
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot run in dry-run mode/);
  assert.equal(result.stderr.includes('private-test-key'), false);
});

test('CLI rejects HE repair without recovery before contacting PowerDNS', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/verify-pdns.js')], {
    env: { ...process.env, PDNS_API_KEY: 'test', PDNS_API_URL: 'http://127.0.0.1:1', PDNS_ZONE: 'is-an.ai.', NOTIFY_ONLY: 'false', REPAIR_HE_NOTIFY: 'true', DRY_RUN: 'false' },
    encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires NOTIFY_ONLY=true/);
});

test('CNAME names and equivalent IPv6 addresses are compared canonically', async t => {
  const { client, data } = fixture(t);
  data.rrsets[0].type = 'CNAME';
  data.rrsets[0].records[0].content = 'target.example.net.';
  t.mock.method(Resolver.prototype, 'resolveCname', async () => ['TARGET.EXAMPLE.NET']);
  await verifyDns(client, 'is-an.ai', 'www.is-an.ai', false);
  data.rrsets[0].type = 'AAAA';
  data.rrsets[0].records[0].content = '2001:0db8:0:0:0:0:0:1';
  t.mock.method(Resolver.prototype, 'resolve6', async () => ['2001:db8::1']);
  await verifyDns(client, 'is-an.ai', 'www.is-an.ai', false);
});
