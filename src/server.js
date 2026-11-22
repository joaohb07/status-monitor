import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Permite que o seu portal MkDocs (GitHub Pages) consulte /api/status via JS
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://joaohb07.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

function getDockerContainers() {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path: '/containers/json?all=1', method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(
              parsed.map((c) => ({
                id: c.Id.slice(0, 12),
                name: c.Names[0]?.replace(/^\//, ''),
                image: c.Image,
                state: c.State,
                status: c.Status,
              }))
            );
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function probeEndpoint(name, url, publicPath = null) {
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
      up: res.ok || res.status < 500,
      statusCode: res.status,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch {
    return { name, url, publicPath, up: false, statusCode: 0, latencyMs: null };
  }
}

function getHostMetrics() {
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
    tempC,
  };
}

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/status', async (_req, res) => {
  const [containers, probes] = await Promise.all([
    getDockerContainers(),
    Promise.all([
      probeEndpoint('Nginx Proxy Manager', 'http://nginx-proxy-manager:81', null),
      probeEndpoint('Task App', 'http://task-app:3000/', '/task-app/'),
      probeEndpoint('Weather App', 'http://weather-app:3000/', '/weather-app/'),
    ]),
  ]);

  res.json({
    timestamp: new Date().toISOString(),
    host: getHostMetrics(),
    containers,
    probes,
  });
});

app.listen(PORT, () => console.log(`Status Monitor running on port ${PORT}`));
