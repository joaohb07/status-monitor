async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const hrs = Math.floor(data.host.uptimeSec / 3600);
    const mins = Math.floor((data.host.uptimeSec % 3600) / 60);

    document.getElementById('updated').textContent =
      `Ubuntu Server • Last updated: ${new Date(data.timestamp).toLocaleTimeString()} • Auto-refresh: 5s`;

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
        </div>
        <div class="card-desc">Average runnable processes across ${data.host.cpuCores} physical cores over time</div>
      </div>

      <div class="card">
        <div>
          <div class="label">Memory Usage</div>
          <div class="value">${data.host.memory.percent}% (${data.host.memory.usedGb}/${data.host.memory.totalGb} GB)</div>
        </div>
        <div class="card-desc">Active physical DDR4 RAM allocated to OS, Docker daemon, and containers</div>
      </div>

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

      <div class="card">
        <div>
          <div class="label">Server Hardware</div>
          <div class="value" style="font-size: 1.15rem;">i5-7400 • 16 GB RAM</div>
        </div>
        <div class="card-desc">4 Cores @ 3.50 GHz • GTX 1060 3GB • 1 TB Storage (Ubuntu 26.10)</div>
      </div>

      ${gpuCard}
    `;

    document.getElementById('probes').innerHTML = data.probes.map((p) => `
      <tr>
        <td><strong>${p.name}</strong></td>
        <td>${p.publicPath ? `<a href="${p.publicPath}">${p.publicPath} ↗</a>` : '<span class="route-internal">Internal</span>'}</td>
        <td><span class="badge ${p.up ? 'up' : 'down'}">${p.up ? 'ONLINE' : 'DOWN'}</span></td>
        <td>${p.statusCode || '-'}</td>
        <td>${p.latencyMs !== null ? p.latencyMs + ' ms' : '-'}</td>
      </tr>
    `).join('');

    document.getElementById('containers').innerHTML = data.containers.map((c) => `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td class="image-cell">${c.image}</td>
        <td><span class="badge ${c.state === 'running' ? 'up' : 'down'}">${c.state}</span></td>
        <td>${c.status}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.getElementById('updated').textContent = 'Connection error fetching telemetry';
  }
}

refresh();
setInterval(refresh, 5000);