import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    // Mantém o modelo neural dentro do bundle; assim ele também carrega no
    // protocolo file:// do AppImage, sem depender de servidor ou CDN.
    assetsInlineLimit: 250_000,
  },
  server: {
    port: 5173,
  },
});
