const express = require('express');
const Docker = require('dockerode');
const { WebSocketServer } = require('ws');
const http = require('http');
const net = require('net');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PORT = 4000;

// Service definitions with health check configs
const SERVICES = [
  { name: 'minio', container: 'minio', type: 'web', port: 9000, healthPath: '/minio/health/live', label: 'MinIO', category: 'Storage', webPort: 9001 },
  { name: 'postgres', container: 'postgres', type: 'tcp', port: 5432, label: 'PostgreSQL (Hive)', category: 'Storage' },
  { name: 'postgres-analytics', container: 'postgres-analytics', type: 'tcp', port: 5432, label: 'PostgreSQL Analytics', category: 'Storage' },
  { name: 'hive-metastore', container: 'hive-metastore', type: 'tcp', port: 9083, label: 'Hive Metastore', category: 'Metadata' },
  { name: 'zookeeper', container: 'zookeeper', type: 'tcp', port: 2181, label: 'Zookeeper', category: 'Kafka' },
  { name: 'kafka', container: 'kafka', type: 'tcp', port: 29092, label: 'Kafka Broker', category: 'Kafka' },
  { name: 'kafka-ui', container: 'kafka-ui', type: 'web', port: 8080, healthPath: '/', label: 'Kafka UI', category: 'Kafka', webPort: 8090 },
  { name: 'kafka-connect', container: 'kafka-connect', type: 'web', port: 8083, healthPath: '/connectors', label: 'Kafka Connect', category: 'Kafka', webPort: 8083 },
  { name: 'logging-server', container: 'logging-server', type: 'web', port: 9998, healthPath: '/health', label: 'Logging Server', category: 'Ingestion', webPort: 9998 },
  { name: 'client', container: 'client', type: 'container', label: 'Weather Client', category: 'Ingestion' },
  { name: 'flink-jobmanager', container: 'flink-jobmanager', type: 'web', port: 8081, healthPath: '/overview', label: 'Flink JobManager', category: 'Processing', webPort: 8081 },
  { name: 'flink-taskmanager', container: 'flink-taskmanager', type: 'container', label: 'Flink TaskManager', category: 'Processing' },
  { name: 'flink-sql-client', container: 'flink-sql-client', type: 'container', label: 'Flink SQL Client', category: 'Processing' },
  { name: 'trino', container: 'trino', type: 'web', port: 8080, healthPath: '/v1/info', label: 'Trino', category: 'Query', webPort: 8080 },
  { name: 'trino-query-ui', container: 'trino-query-ui', type: 'web', port: 3001, healthPath: '/', label: 'Trino Query UI', category: 'Query', webPort: 3001 },
  { name: 'visualization-server', container: 'visualization-server', type: 'web', port: 3000, healthPath: '/health', label: 'Visualization', category: 'Visualization', webPort: 3000 },
];

app.use(express.static('public'));
app.use(express.json());

// Check TCP port
function checkTcp(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.connect(port, host);
  });
}

// Check HTTP endpoint
async function checkHttp(host, port, path, timeout = 3000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(`http://${host}:${port}${path}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok || response.status < 500;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

// Get container status
async function getContainerStatus(containerName) {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    return {
      exists: true,
      running: info.State.Running,
      paused: info.State.Paused,
      status: info.State.Status,
      health: info.State.Health?.Status || 'none',
      startedAt: info.State.StartedAt,
    };
  } catch {
    return { exists: false, running: false, paused: false, status: 'not found', health: 'none' };
  }
}

// Get container logs
async function getContainerLogs(containerName, tail = 100) {
  try {
    const container = docker.getContainer(containerName);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    
    // Parse docker logs format (remove header bytes)
    const logStr = logs.toString('utf8');
    const lines = logStr.split('\n')
      .map(line => {
        // Remove Docker stream header (8 bytes)
        if (line.length > 8) {
          return line.substring(8);
        }
        return line;
      })
      .filter(line => line.trim());
    
    return lines;
  } catch (error) {
    return [`Error fetching logs: ${error.message}`];
  }
}

// Get service health status
async function getServiceHealth(service) {
  const containerStatus = await getContainerStatus(service.container);
  
  let serviceUp = false;
  
  if (containerStatus.running) {
    switch (service.type) {
      case 'web':
        serviceUp = await checkHttp(service.container, service.port, service.healthPath);
        break;
      case 'tcp':
        serviceUp = await checkTcp(service.container, service.port);
        break;
      case 'container':
        serviceUp = containerStatus.running;
        break;
    }
  }
  
  return {
    ...service,
    container: containerStatus,
    serviceUp,
    timestamp: new Date().toISOString(),
  };
}

// API: Get all services status
app.get('/api/services', async (req, res) => {
  try {
    const statuses = await Promise.all(SERVICES.map(getServiceHealth));
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get logs for a container
app.get('/api/logs/:container', async (req, res) => {
  try {
    const logs = await getContainerLogs(req.params.container, parseInt(req.query.tail) || 100);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get all containers
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    res.json(containers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Pause a container
app.post('/api/containers/:container/pause', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.container);
    const info = await container.inspect();
    
    if (!info.State.Running) {
      return res.status(400).json({ error: 'Container is not running' });
    }
    
    if (info.State.Paused) {
      return res.status(400).json({ error: 'Container is already paused' });
    }
    
    await container.pause();
    console.log(`Container ${req.params.container} paused`);
    res.json({ success: true, message: `Container ${req.params.container} paused` });
  } catch (error) {
    console.error(`Error pausing container: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// API: Unpause a container
app.post('/api/containers/:container/unpause', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.container);
    const info = await container.inspect();
    
    if (!info.State.Paused) {
      return res.status(400).json({ error: 'Container is not paused' });
    }
    
    await container.unpause();
    console.log(`Container ${req.params.container} unpaused`);
    res.json({ success: true, message: `Container ${req.params.container} resumed` });
  } catch (error) {
    console.error(`Error unpausing container: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// API: Stop a container
app.post('/api/containers/:container/stop', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.container);
    const info = await container.inspect();
    
    if (!info.State.Running) {
      return res.status(400).json({ error: 'Container is not running' });
    }
    
    await container.stop();
    console.log(`Container ${req.params.container} stopped`);
    res.json({ success: true, message: `Container ${req.params.container} stopped` });
  } catch (error) {
    console.error(`Error stopping container: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// API: Start a container
app.post('/api/containers/:container/start', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.container);
    const info = await container.inspect();
    
    if (info.State.Running) {
      return res.status(400).json({ error: 'Container is already running' });
    }
    
    await container.start();
    console.log(`Container ${req.params.container} started`);
    res.json({ success: true, message: `Container ${req.params.container} started` });
  } catch (error) {
    console.error(`Error starting container: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// API: Restart a container
app.post('/api/containers/:container/restart', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.container);
    await container.restart();
    console.log(`Container ${req.params.container} restarted`);
    res.json({ success: true, message: `Container ${req.params.container} restarted` });
  } catch (error) {
    console.error(`Error restarting container: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket for real-time updates
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  const sendUpdate = async () => {
    try {
      const statuses = await Promise.all(SERVICES.map(getServiceHealth));
      ws.send(JSON.stringify({ type: 'status', data: statuses }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  };
  
  // Send initial status
  sendUpdate();
  
  // Send updates every 5 seconds
  const interval = setInterval(sendUpdate, 5000);
  
  ws.on('message', async (message) => {
    try {
      const { action, container, tail } = JSON.parse(message);
      
      if (action === 'logs') {
        const logs = await getContainerLogs(container, tail || 100);
        ws.send(JSON.stringify({ type: 'logs', container, logs }));
      } else if (action === 'refresh') {
        sendUpdate();
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    clearInterval(interval);
  });
});

server.listen(PORT, () => {
  console.log(`Service Dashboard running at http://localhost:${PORT}`);
});
