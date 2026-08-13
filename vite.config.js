import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// HTTPS is the default because getUserMedia needs a secure context when the page is
// reached over the LAN from a phone. Set VITE_NO_HTTPS=1 for headless browser testing
// on localhost, which is a secure context over plain HTTP and avoids the self-signed
// certificate blocking automated navigation.
const useHttps = process.env.VITE_NO_HTTPS !== '1'

export default defineConfig({
  plugins: [
    react(),
    ...(useHttps ? [basicSsl()] : [])
  ],
  server: {
    // Exposes the project on your local network IP
    host: true,
    // Optional: force a specific port
    port: 5173
  }
})
