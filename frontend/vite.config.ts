import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: the browser talks to :5173 only. /api is proxied to the Node API, and /images is
// served from ../assets (standing in for S3). Production: CloudFront does the same routing.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  publicDir: command === 'serve' ? '../assets' : false,
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
}));
