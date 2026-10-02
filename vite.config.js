import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [vue(), basicSsl()],
  server: { https: true },
  // 隱私紅線：正式 bundle 不得殘留任何 console 輸出
  // 保留 esbuild.drop（brief 原始指定值）；但本專案實際裝出的 vite@8 已改用
  // rolldown + oxc 作為預設 minifier，esbuild 選項在 build 階段會被忽略
  // （vitest 啟動時也會印出「oxc options will be used and esbuild options
  // will be ignored」的警告）。經實測驗證：只設 esbuild.drop 時，正式 bundle
  // 仍殘留 console 呼叫（含 Vue 內部的 console.error）。因此下面用 rolldown
  // 的 output.minify.compress 選項才是實際生效、真正擋住 console 輸出的設定。
  esbuild: { drop: ['console', 'debugger'] },
  build: {
    target: 'safari16',
    rolldownOptions: {
      // src/sw.js 必須跟 index.html 一起建置成獨立進入點，
      // 而且輸出檔名要固定叫 /sw.js（見下面 output.entryFileNames），
      // 否則 registration 的 scope 對不上、或使用者拿到帶 hash 的舊檔名。
      input: {
        main: 'index.html',
        sw: 'src/sw.js',
      },
      output: {
        minify: { compress: { dropConsole: true, dropDebugger: true } },
        // SW 必須固定叫 /sw.js 且在根目錄，否則 scope 不對
        entryFileNames: (chunk) => (chunk.name === 'sw' ? '[name].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
