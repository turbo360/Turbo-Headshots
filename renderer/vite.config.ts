import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev needs the HMR websocket + react-refresh preamble; production stays strict.
const devCsp =
  "default-src 'self'; img-src 'self' media: data: blob:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; connect-src 'self' ws://localhost:5173; script-src 'self' 'unsafe-inline'";

export default defineConfig(({ command }) => ({
  root: __dirname,
  base: './',
  plugins: [
    react(),
    {
      name: 'dev-csp',
      transformIndexHtml(html) {
        if (command !== 'serve') return html;
        return html.replace(/content="default-src[^"]*"/, `content="${devCsp}"`);
      },
    },
  ],
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
