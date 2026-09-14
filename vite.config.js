import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// HTTPS is the default because getUserMedia needs a secure context when the page is
// reached over the LAN from a phone. Set VITE_NO_HTTPS=1 for headless browser testing
// on localhost, which is a secure context over plain HTTP and avoids the self-signed
// certificate blocking automated navigation.
const useHttps = process.env.VITE_NO_HTTPS !== '1'

// Dev-only: POST a compact export here and it lands in calibration/ as a replayable
// file, so a capture taken on the phone never has to be copied off it by hand.
function captureSink() {
  return {
    name: 'capture-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('POST only')
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          let line = body.trim()
          let note = ''
          if (!line.startsWith('CQ')) {
            try {
              const parsed = JSON.parse(line)
              line = String(parsed.export || '').trim()
              note = String(parsed.note || '').trim()
            } catch {
              res.statusCode = 400
              return res.end('body must be a CQ line or {export, note} JSON')
            }
          }
          const [version, rawTag] = line.split('|', 2)
          if (!/^CQ\d+$/.test(version || '')) {
            res.statusCode = 400
            return res.end('unrecognised export header')
          }
          const tag = (rawTag || 'untagged').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
          const name = `${stamp}-${tag}.${version.toLowerCase()}.txt`
          const dir = resolve(import.meta.dirname, 'calibration')
          mkdirSync(dir, { recursive: true })
          // The parser skips any line without a CQ prefix, so the note rides along in the
          // same file rather than in a sidecar that can get separated from its recording.
          const noteBlock = note ? note.split(/\r?\n/).map((l) => `# ${l}`).join('\n') + '\n' : ''
          writeFileSync(resolve(dir, name), noteBlock + line + '\n')
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ saved: name, bytes: line.length }))
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    captureSink(),
    ...(useHttps ? [basicSsl()] : [])
  ],
  server: {
    // Exposes the project on your local network IP
    host: true,
    // Optional: force a specific port
    port: 5173
  }
})
