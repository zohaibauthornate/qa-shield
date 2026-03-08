export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>🛡️ QA Shield</h1>
      <p>Automated QA lifecycle platform for Creator.fun</p>
      <h2>API Endpoints</h2>
      <ul>
        <li><code>POST /api/enrich</code> — Enrich a Linear ticket with AI analysis</li>
        <li><code>POST /api/security/scan</code> — Scan endpoints for security issues</li>
        <li><code>GET /api/monitor/health</code> — Health check & performance monitoring</li>
        <li><code>GET /api/monitor/health?mode=benchmark</code> — Competitive benchmark</li>
      </ul>
    </main>
  );
}
