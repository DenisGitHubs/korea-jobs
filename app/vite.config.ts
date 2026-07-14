import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server pinned to 5180 (see .claude/launch.json). `npm run dev` loads
// .env.development (VITE_API_MODE=mock) so the app opens in a plain browser
// on mock data — no backend required.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 5180,
    strictPort: true,
  },
});
