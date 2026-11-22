import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
const PORT = process.env.PORT || 3000;

// Circular buffer for the last 60 samples (5 minutes at 5s interval)
const MAX_HISTORY_POINTS = 60;
export const telemetryHistory = [];

// In-memory cache for GitHub Actions workflow runs (60s TTL to respect rate limits)
let deployCache = { expiresAt: 0, data: {} };

const DEPLOY_REPOS = [
  { key: 'status-monitor', owner: 'joaohb07', repo: 'status-monitor', workflow: 'deploy.yml' },
  { key: 'task-app', owner: 'joaohb07', repo: 'task-app', workflow: 'deploy.yml' },
  { key: 'weather-app', owner: 'joaohb07', repo: 'weather-app', workflow: 'deploy.yml' },
];

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

export async function getGpuMetrics(runCommand = execFileAsync, telemetryFile = '/tmp/gpu-telemetry.json') {
  try {
    let rawOutput = '';
    if (fs.existsSync(telemetryFile)) {
      rawOutput = fs.readFileSync(telemetryFile, 'utf8');
    } else {
      const { stdout } = await runCommand('nvidia-smi', [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ], { timeout: 2000 });
      rawOutput = stdout;
    }

    const [name, util, memUsed, memTotal, temp] = rawOutput.trim().split(',').map((s) => s.trim());
    if (!name) return { available: false };

    return {
      available: true,
      name,
      utilizationPercent: Number(util),
      memoryUsedMb: Number(memUsed),
      memoryTotalMb: Number(memTotal),
      tempC: Number(temp),
    };
  } catch {
    return { available: false };
  }
}

export function getStorageMetrics(mountPath = '/') {
  try {
    const stats = fs.statfsSync(mountPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    return {
      available: true,
      mount: mountPath,
      totalGb: (totalBytes / 1024 ** 3).toFixed(2),
      usedGb: (usedBytes / 1024 ** 3).toFixed(2),
      freeGb: (freeBytes / 1024 ** 3).toFixed(2),
      percent: totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0,
    };
  } catch {
    return { available: false };
  }
}

function dockerSocketGet(socketPath, endpointPath, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: endpointPath, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Docker socket timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

export function calculateContainerStats(stats) {
  if (!stats || !stats.memory_stats || !stats.cpu_stats) {
    return { cpuPercent: null, memoryMb: null };
  }

  // Memory usage excluding page cache (cgroups v1 & v2 compatible)
  const rawUsage = stats.memory_stats.usage || 0;
  const cache = stats.memory_stats.stats?.file ?? stats.memory_stats.stats?.cache ?? 0;
  const activeMemBytes = Math.max(0, rawUsage - cache);
  const memoryMb = Number((activeMemBytes / 1024 ** 2).toFixed(1));

  // CPU delta calculation
  const cpuDelta =
    (stats.cpu_stats.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage || 0) -
    (stats.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus =
    stats.cpu_stats.online_cpus ||
    stats.cpu_stats.cpu_usage?.percpu_usage?.length ||
    1;

  let cpuPercent = 0;
  if (systemDelta > 0 && cpuDelta > 0) {
    cpuPercent = Number(((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2));
  }

  return { cpuPercent, memoryMb };
}

export async function getDockerContainers(socketPath = '/var/run/docker.sock') {
  try {
    const parsed = await dockerSocketGet(socketPath, '/containers/json?all=1');
    if (!Array.isArray(parsed)) return [];

    return await Promise.all(
      parsed.map(async (c) => {
        const id = c.Id.slice(0, 12);
        const name = c.Names[0]?.replace(/^\//, '');
        let stats = { cpuPercent: null, memoryMb: null };

        if (c.State === 'running') {
          try {
            const rawStats = await dockerSocketGet(
              socketPath,
              `/containers/${id}/stats?stream=false`,
              2500
            );
            stats = calculateContainerStats(rawStats);
          } catch {
            // Keep null metrics if stats query times out
          }
        }

        return {
          id,
          name,
          image: c.Image,
          state: c.State,
          status: c.Status,
          cpuPercent: stats.cpuPercent,
          memoryMb: stats.memoryMb,
        };
      })
    );
  } catch {
    return [];
  }
}

export async function probeEndpoint(name, url, publicPath = null, repoKey = null) {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return {
      name,
      url,
      publicPath,
      repoKey,
      up: res.ok || res.status < 500,
      statusCode: res.status,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch {
    return { name, url, publicPath, repoKey, up: false, statusCode: 0, latencyMs: null };
  }
}

export async function getLatestDeploys(fetchFn = fetch, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && deployCache.expiresAt > now) {
    return deployCache.data;
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jhbserver-status-monitor',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const results = await Promise.all(
    DEPLOY_REPOS.map(async ({ key, owner, repo, workflow }) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetchFn(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
          { headers, signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!res.ok) return [key, null];
        const json = await res.json();
        const run = json.workflow_runs?.[0];
        if (!run) return [key, null];

        return [
          key,
          {
            repo: `${owner}/${repo}`,
            sha: run.head_sha?.slice(0, 7) || null,
            conclusion: run.conclusion || run.status, // e.g., 'success', 'failure', 'in_progress'
            htmlUrl: run.html_url,
            updatedAt: run.updated_at,
          },
        ];
      } catch {
        return [key, null];
      }
    })
  );

  const map = Object.fromEntries(results);
  deployCache = { expiresAt: now + 60_000, data: map };
  return map;
}

export function getHostMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  let tempC = null;
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    tempC = (parseInt(raw.trim(), 10) / 1000).toFixed(1);
  } catch {}

  return {
    hostname: os.hostname(),
    uptimeSec: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    cpuCores: os.cpus().length,
    memory: {
      totalGb: (totalMem / 1024 ** 3).toFixed(2),
      usedGb: (usedMem / 1024 ** 3).toFixed(2),
      percent: Math.round((usedMem / totalMem) * 100),
    },
    storage: getStorageMetrics('/'),
    tempC,
  };
}

export function recordHistorySample(hostMetrics) {
  telemetryHistory.push({
    timestamp: new Date().toISOString(),
    cpuLoad1m: hostMetrics.loadAvg[0],
    memoryPercent: hostMetrics.memory.percent,
  });
  if (telemetryHistory.length > MAX_HISTORY_POINTS) {
    telemetryHistory.shift();
  }
  return telemetryHistory;
}

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/status', async (_req, res) => {
  const host = getHostMetrics();
  const history = recordHistorySample(host);

  const [gpu, containers, probes, deploys] = await Promise.all([
    getGpuMetrics(),
    getDockerContainers(),
    Promise.all([
      probeEndpoint('Nginx Proxy Manager', 'http://nginx-proxy-manager:81', null, null),
      probeEndpoint('Task App', 'http://task-app:3000/', '/task-app/', 'task-app'),
      probeEndpoint('Weather App', 'http://weather-app:3000/', '/weather-app/', 'weather-app'),
    ]),
    getLatestDeploys(),
  ]);

  const enrichedProbes = probes.map((p) => ({
    ...p,
    deploy: p.repoKey ? deploys[p.repoKey] || null : null,
  }));

  const enrichedContainers = containers.map((c) => ({
    ...c,
    deploy: deploys[c.name] || null,
  }));

  res.json({
    timestamp: new Date().toISOString(),
    host,
    gpu,
    history,
    deploys,
    containers: enrichedContainers,
    probes: enrichedProbes,
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const initialHost = getHostMetrics();
  recordHistorySample(initialHost);
  setInterval(() => {
    recordHistorySample(getHostMetrics());
  }, 5000).unref();

  app.listen(PORT, () => console.log(`Status Monitor running on port ${PORT}`));
}