const express = require('express');
const QRCode = require('qrcode');
const os = require('os');
const router = express.Router();
const config = require('../config');

// Helper to get the local network IP a phone on the same Wi-Fi can actually
// reach. Machines often have several adapters (WSL, Hyper-V, Docker, VPNs like
// Tailscale, packet-capture loopbacks) whose IPs look private but are NOT on the
// real LAN — picking one of those makes the join QR code unreachable from phones.
// So we explicitly skip virtual adapters and prefer Wi-Fi/Ethernet.
function getLocalIP() {
  // Explicit override wins — handy for unusual multi-adapter / VPN setups.
  if (process.env.HOST_IP) return process.env.HOST_IP;

  const interfaces = os.networkInterfaces();

  // Adapter names that are virtual and almost never the real LAN address.
  const virtualName = /(vethernet|wsl|hyper-?v|virtualbox|vmware|loopback|npcap|docker|tailscale|zerotier|bridge|\btun\b|\btap\b|utun|veth)/i;
  // RFC1918 private LAN ranges.
  const privateIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
  // Always skip link-local (169.254/16) and Tailscale CGNAT (100.64/10).
  const skipIP = (ip) => /^169\.254\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  // Adapters that are clearly the physical network connection.
  const physicalName = /(wi-?fi|wlan|ethernet|^en\d|^eth\d)/i;

  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, ip: iface.address });
      }
    }
  }

  const lanCandidates = candidates.filter(
    (c) => !virtualName.test(c.name) && !skipIP(c.ip) && privateIP.test(c.ip)
  );

  // Prefer an obviously-physical adapter, else any non-virtual LAN address.
  const best = lanCandidates.find((c) => physicalName.test(c.name)) || lanCandidates[0];
  if (best) return best.ip;

  // Fallbacks: any private IP, then any external IPv4, then localhost.
  const anyPrivate = candidates.find((c) => !skipIP(c.ip) && privateIP.test(c.ip));
  return (anyPrivate && anyPrivate.ip) || (candidates[0] && candidates[0].ip) || 'localhost';
}

const LOCAL_IP = getLocalIP();

// API endpoint to retrieve connection configuration and generate QR code
router.get('/config', async (req, res) => {
  const roomCode = req.query.roomCode || Math.random().toString(36).substring(2, 6).toUpperCase();

  // Use host header to dynamically build the join URL.
  // IMPORTANT: If the request comes from localhost (same machine), swap in the
  // server's LAN IP so QR codes are reachable by mobile phones on the same WiFi.
  let host = req.get('host'); // e.g. "localhost:3000" or "192.168.1.5:3000"
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    host = `${LOCAL_IP}:${config.PORT}`;
  }

  // Always use https — the dev server runs HTTPS for DeviceOrientation API access.
  // Mobile users will see a cert warning and must tap "Advanced → Proceed".
  const protocol = 'https';
  const joinUrl = `${protocol}://${host}/join/${roomCode}`;
  
  try {
    // Generate QR code data URL
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
      color: {
        dark: '#ffffff', // White QR code
        light: '#0b001a', // Dark theme background
      },
      margin: 1,
      width: 256,
    });
    
    res.json({
      localIp: LOCAL_IP,
      port: config.PORT,
      roomCode,
      joinUrl,
      qrDataUrl
    });
  } catch (err) {
    console.error('Error generating QR code:', err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

module.exports = router;
