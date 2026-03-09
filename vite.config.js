export default defineConfig({
  build: {
    lib: {
      entry: 'src/main.jsx',
      name: 'StoneCanvas',
      fileName: 'stone-canvas',
      formats: ['umd']
    },
    rollupOptions: {
      external: [],
    }
  }
})