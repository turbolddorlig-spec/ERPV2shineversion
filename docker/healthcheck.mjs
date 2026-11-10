// Docker health check: /api/health хариу өгөх эсэх (database холболт орно)
fetch('http://127.0.0.1:3000/api/health')
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
