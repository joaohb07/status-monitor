function renderSparkline(values, { min = 0, max = 100, stroke = '#78a9ff', fillId = 'spark-grad' } = {}) {
  if (!Array.isArray(values) || values.length < 2) {
    return `<div class="card-desc" style="margin-top:0.5rem;">Collecting 5-min history (${values?.length || 1}/60 samples)...</div>`;
  }

  const width = 260;
  const height = 34;
  const effectiveMax = Math.max(max, ...values, 0.1);
  const range = Math.max(0.01, effectiveMax - min);

  const coords = values.map((val, idx) => {
    const x = (idx / (values.length - 1)) * width;
    const clamped = Math.min(effectiveMax, Math.max(min, val));
    const y = height - ((clamped - min) / range) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const linePoints = coords.join(' ');
  const areaPoints = `0,${height} ${linePoints} ${width},${height}`;

  return `
    <div class="sparkline-wrap" title="Last ${values.length * 5}s (${values.length} samples)">
      <svg class="sparkline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${stroke}" stop-opacity="0.28" />
            <stop offset="100%" stop-color="${stroke}" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        <polygon points="${areaPoints}" fill="url(#${fillId})" />
        <polyline
          fill="none"
          stroke="${stroke}"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          points="${linePoints}"
        />
      </svg>
    </div>
  `;
}

function renderDeployBadge(deploy) {
  if (!deploy) return '<span class="route-internal">—</span>';

  const isSuccess = deploy.conclusion === 'success';
  const isFailure = deploy.conclusion === 'failure' || deploy.conclusion === 'cancelled';
  const badgeClass = isSuccess ? 'up' : isFailure ? 'down' : 'pending';
  const label = isSuccess ? 'Passing' : isFailure ? 'Failed' : 'Running';

  return `
    <a href="${deploy.htmlUrl}" target="_blank" rel="noreferrer" class="deploy-pill" title="GitHub Actions deploy.yml">
      <span class="badge ${badgeClass}">${label}</span>
      ${deploy.sha ? `<span class="commit-hash">${deploy.sha}</span>` : ''}
    </a>
  `;
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const hrs = Math.floor(data.host.uptimeSec / 3600);
    const mins = Math.floor((data.host.uptimeSec % 3600) / 60);

    document.getElementById('updated').textContent =
      `Ubuntu Server • Last updated: ${new Date(data.timestamp).toLocaleTimeString()} • Auto-refresh: 5s`;

    const history = Array.isArray(data.history) ? data.history : [];
    const cpuSeries = history.map((h) => h.cpuLoad1m);
    const memSeries = history.map((h) => h.memoryPercent);

    const storage = data.host.storage;
    const storageBarClass =
      storage?.percent >= 85 ? 'crit' : storage?.percent >= 70 ? 'warn' : '';

    const storageCard = storage?.available
      ? `
        <div class="card">
          <div>
            <div class="label">Root Storage (/)</div>
            <div class="value">${storage.percent}% (${storage.usedGb} / ${storage.totalGb} GB)</div>
            <div class="storage-bar">
              <div class="storage-bar-fill ${storageBarClass}" style="width: ${Math.min(100, storage.percent)}%"></div>
            </div>
          </div>
          <div class="card-desc">${storage.freeGb} GB available on root filesystem • Docker & MongoDB volumes</div>
        </div>`
      : '';

    const gpuCard = data.gpu?.available
      ? `
        <div class="card">
          <div>
            <div class="label">GPU Telemetry (${data.gpu.name})</div>
            <div class="value">${data.gpu.utilizationPercent}% • ${data.gpu.tempC} °C</div>
          </div>
          <div class="card-desc">VRAM: ${data.gpu.memoryUsedMb} / ${data.gpu.memoryTotalMb} MB • CUDA compute utilization</div>
        </div>`
      : `
        <div class="card">
          <div>
            <div class="label">GPU Telemetry</div>
            <div class="value">N/A</div>
          </div>
          <div class="card-desc">NVIDIA GeForce GTX 1060 3GB • Dedicated CUDA compute</div>
        </div>`;

    document.getElementById('host-cards').innerHTML = `
      <div class="card">
        <div>
          <div class="label">CPU Load (1m / 5m / 15m)</div>
          <div class="value">${data.host.loadAvg.join(' / ')}</div>
          ${renderSparkline(cpuSeries, {
            min: 0,
            max: data.host.cpuCores,
            stroke: '#78a9ff',
            fillId: 'cpu-spark',
          })}
        </div>
        <div class="card-desc">5-min load trend across ${data.host.cpuCores} physical cores</div>
      </div>

      <div class="card">
        <div>
          <div class="label">Memory Usage</div>
          <div class="value">${data.host.memory.percent}% (${data.host.memory.usedGb}/${data.host.memory.totalGb} GB)</div>
          ${renderSparkline(memSeries, {
            min: 0,
            max: 100,
            stroke: '#42be65',
            fillId: 'mem-spark',
          })}
        </div>
        <div class="card-desc">5-min physical DDR4 RAM trend (OS, Docker & containers)</div>
      </div>

      ${storageCard}

      <div class="card">
        <div>
          <div class="label">Host Uptime</div>
          <div class="value">${hrs}h ${mins}m</div>
        </div>
        <div class="card-desc">Continuous system availability since last kernel boot</div>
      </div>

      <div class="card">
        <div>
          <div class="label">CPU Temp</div>
          <div class="value">${data.host.tempC ? data.host.tempC + ' °C' : 'N/A'}</div>
        </div>
        <div class="card-desc">Thermal package sensor reading from Linux kernel sysfs</div>
      </div>

      ${gpuCard}
    `;

    document.getElementById('probes').innerHTML = data.probes.map((p) => `
      <tr>
        <td><strong>${p.name}</strong></td>
        <td>${p.publicPath ? `<a href="${p.publicPath}">${p.publicPath} ↗</a>` : '<span class="route-internal">Internal</span>'}</td>
        <td><span class="badge ${p.up ? 'up' : 'down'}">${p.up ? 'ONLINE' : 'DOWN'}</span></td>
        <td>${renderDeployBadge(p.deploy)}</td>
        <td>${p.statusCode || '-'}</td>
        <td>${p.latencyMs !== null ? p.latencyMs + ' ms' : '-'}</td>
      </tr>
    `).join('');

    document.getElementById('containers').innerHTML = data.containers.map((c) => `
      <tr>
        <td>
          <strong>${c.name}</strong>
          ${c.deploy ? `<div style="margin-top:0.3rem;">${renderDeployBadge(c.deploy)}</div>` : ''}
        </td>
        <td class="image-cell">${c.image}</td>
        <td><span class="badge ${c.state === 'running' ? 'up' : 'down'}">${c.state}</span></td>
        <td class="mono-cell">${c.cpuPercent !== null && c.cpuPercent !== undefined ? c.cpuPercent.toFixed(2) + '%' : '-'}</td>
        <td class="mono-cell">${c.memoryMb !== null && c.memoryMb !== undefined ? c.memoryMb + ' MB' : '-'}</td>
        <td>${c.status}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.getElementById('updated').textContent = 'Connection error fetching telemetry';
  }
}

refresh();
setInterval(refresh, 5000);