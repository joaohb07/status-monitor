import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, getHostMetrics, probeEndpoint, getDockerContainers } from '../src/server.js';

describe('Home-Lab Status Monitor API & Telemetry', () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves the portal HTML on root route /', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /jhbserver — Self-Hosted Home-Lab/);
  });

  it('returns structured host metrics from getHostMetrics()', () => {
    const host = getHostMetrics();
    assert.equal(typeof host.hostname, 'string');
    assert.equal(host.loadAvg.length, 3);
    assert.ok(host.cpuCores >= 1);
    assert.ok(host.memory.percent >= 0 && host.memory.percent <= 100);
  });

  it('handles unreachable endpoints gracefully in probeEndpoint()', async () => {
    const result = await probeEndpoint('Unreachable Service', 'http://127.0.0.1:59999', '/down/');
    assert.equal(result.up, false);
    assert.equal(result.statusCode, 0);
    assert.equal(result.latencyMs, null);
    assert.equal(result.publicPath, '/down/');
  });

  it('returns empty array when Docker socket is unavailable', async () => {
    const containers = await getDockerContainers('/tmp/non-existent-docker.sock');
    assert.deepEqual(containers, []);
  });

  it('exposes /api/status with CORS restricted to GitHub Pages documentation', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://joaohb07.github.io');
    assert.ok(typeof body.timestamp === 'string');
    assert.ok(Array.isArray(body.containers));
    assert.equal(body.probes.length, 3);
  });
});
