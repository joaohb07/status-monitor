import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  getHostMetrics,
  getGpuMetrics,
  probeEndpoint,
  getDockerContainers,
} from '../src/server.js';

describe('Home-Lab Status Monitor API, Assets & Telemetry', () => {
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

  it('serves the portal HTML and external static assets (/css/style.css, /js/app.js)', async () => {
    const [htmlRes, cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/css/style.css`),
      fetch(`${baseUrl}/js/app.js`),
    ]);

    const html = await htmlRes.text();
    const css = await cssRes.text();
    const js = await jsRes.text();

    assert.equal(htmlRes.status, 200);
    assert.match(html, /jhbserver — Self-Hosted Home-Lab/);
    assert.match(html, /href="\/css\/style\.css"/);
    assert.match(html, /src="\/js\/app\.js"/);

    assert.equal(cssRes.status, 200);
    assert.match(css, /\.card-desc/);

    assert.equal(jsRes.status, 200);
    assert.match(js, /Server Hardware/);
    assert.match(js, /GPU Telemetry/);
  });

  it('returns structured host metrics from getHostMetrics()', () => {
    const host = getHostMetrics();
    assert.equal(typeof host.hostname, 'string');
    assert.equal(host.loadAvg.length, 3);
    assert.ok(host.cpuCores >= 1);
    assert.ok(host.memory.percent >= 0 && host.memory.percent <= 100);
  });

  it('reads GPU metrics from the mounted telemetry file when present', async () => {
    const tempFile = path.join(os.tmpdir(), `gpu-telemetry-test-${Date.now()}.json`);
    fs.writeFileSync(tempFile, 'NVIDIA GeForce GTX 1060 3GB, 15, 420, 3072, 51\n', 'utf8');

    try {
      const gpu = await getGpuMetrics(undefined, tempFile);
      assert.deepEqual(gpu, {
        available: true,
        name: 'NVIDIA GeForce GTX 1060 3GB',
        utilizationPercent: 15,
        memoryUsedMb: 420,
        memoryTotalMb: 3072,
        tempC: 51,
      });
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  });

  it('parses nvidia-smi CSV output accurately when telemetry file is absent', async () => {
    const mockRunner = async () => ({
      stdout: 'NVIDIA GeForce GTX 1060 3GB, 24, 512, 3072, 48\n',
    });

    const gpu = await getGpuMetrics(mockRunner, '/tmp/non-existent-gpu.json');
    assert.deepEqual(gpu, {
      available: true,
      name: 'NVIDIA GeForce GTX 1060 3GB',
      utilizationPercent: 24,
      memoryUsedMb: 512,
      memoryTotalMb: 3072,
      tempC: 48,
    });
  });

  it('falls back gracefully when both telemetry file and nvidia-smi are unavailable', async () => {
    const failingRunner = async () => {
      throw new Error('spawn nvidia-smi ENOENT');
    };

    const gpu = await getGpuMetrics(failingRunner, '/tmp/non-existent-gpu.json');
    assert.deepEqual(gpu, { available: false });
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

  it('handles CORS preflight OPTIONS requests on /api/status with 204', async () => {
    const res = await fetch(`${baseUrl}/api/status`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods'), /GET/);
  });

  it('exposes /api/status with host, gpu, containers, and probes payloads', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(typeof body.timestamp === 'string');
    assert.equal(typeof body.gpu.available, 'boolean');
    assert.ok(Array.isArray(body.containers));
    assert.equal(body.probes.length, 3);
  });
});