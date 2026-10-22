// Serves api/relay.js (the Vercel Function) on a local port for the e2e tests, unchanged.
//   RELAYER_KEY=0x... node e2e/relay-server.mjs 4790
import { createServer } from 'node:http'
import * as api from '../api/relay.js'

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
  const handler = api[req.method]
  const response = handler ? await handler(request) : new Response(null, { status: 405 })
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(Number(process.argv[2] ?? 4790))
