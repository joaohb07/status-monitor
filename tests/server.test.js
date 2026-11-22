import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  getHostMetrics,
  getStorageMetrics,
  getGpuMetrics,
  probeEndpoint,
  getDockerContainers,
  calculateContainerStats,
  recordHistorySample,
  telemetryHistory,
  getLatestDeploys,
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
    assert.match(html, /Last Deploy/);
    assert.match(html, /Memory/);

    assert.equal(cssRes.status, 200);
    assert.match(css, /\.sparkline-svg/);
    assert.match(css, /\.storage-bar/);

    assert.equal(jsRes.status, 200);
    assert.match(js, /Root Storage/);
    assert.match(js, /renderSparkline/);
  });

  it('returns structured host and root storage metrics', () => {
    const host = getHostMetrics();
    assert.equal(typeof host.hostname, 'string');
    assert.equal(host.loadAvg.length, 3);
    assert.ok(host.cpuCores >= 1);
    assert.ok(host.memory.percent >= 0 && host.memory.percent <= 100);

    const storage = getStorageMetrics('/');
    assert.equal(storage.available, true);
    assert.ok(Number(storage.totalGb) > 0);
    assert.ok(storage.percent >= 0 && storage.percent <= 100);
  });

  it('calculates Docker container CPU percentage and active RAM (excluding cache)', () => {
    const sampleDockerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 500_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 10_000_000_000,
        online_cpus: 4,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 300_000_000 },
        system_cpu_usage: 8_000_000_000,
      },
      memory_stats: {
        usage: 150 * 1024 ** 2,
        stats: { file: 22 * 1024 ** 2 },
      },
    };

    const parsed = calculateContainerStats(sampleDockerStats);
    assert.equal(parsed.cpuPercent, 40);
    assert.equal(parsed.memoryMb, 128);
  });

  it('caps the circular telemetry history buffer at 60 samples', () => {
    telemetryHistory.length = 0;
    const mockHost = { loadAvg: [0.25, 0.2, 0.15], memory: { percent: 18 } };

    for (let i = 0; i < 65; i++) {
      recordHistorySample(mockHost);
    }

    assert.equal(telemetryHistory.length, 60);
    assert.equal(telemetryHistory[0].cpuLoad1m, 0.25);
    assert.equal(telemetryHistory[0].memoryPercent, 18);
  });

  it('fetches and parses latest GitHub Actions workflow runs with caching', async () => {
    const mockFetch = async (url) => ({
      ok: true,
      json: async () => ({
        workflow_runs: [
          {
            head_sha: 'a1b2c3d4e5f6',
            conclusion: 'success',
            html_url: `${url}/runs/1`,
            updated_at: '2026-11-22T18:00:00Z',
          },
        ],
      }),
    });

    const deploys = await getLatestDeploys(mockFetch, true);
    assert.equal(deploys['task-app'].sha, 'a1b2c3d');
    assert.equal(deploys['task-app'].conclusion, 'success');
    assert.equal(deploys['weather-app'].sha, 'a1b2c3d');
    assert.equal(deploys['status-monitor'].sha, 'a1b2c3d');
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

  it('handles unreachable endpoints gracefully in probeEndpoint()', async () => {
    const result = await probeEndpoint('Unreachable Service', 'http://127.0.0.1:59999', '/down/', 'down-repo');
    assert.equal(result.up, false);
    assert.equal(result.statusCode, 0);
    assert.equal(result.latencyMs, null);
    assert.equal(result.publicPath, '/down/');
    assert.equal(result.repoKey, 'down-repo');
  });

  it('returns empty array when Docker socket is unavailable', async () => {
    const containers = await getDockerContainers('/tmp/non-existent-docker.sock');
    assert.deepEqual(containers, []);
  });

  it('exposes /api/status with host.storage, history, deploys, containers, and probes', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(body.host.storage);
    assert.ok(Array.isArray(body.history));
    assert.ok(typeof body.deploys === 'object');
    assert.ok(Array.isArray(body.containers));
    assert.equal(body.probes.length, 3);
  });
});