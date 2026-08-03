// @ts-check
import { defineConfig } from 'astro/config';

// oldyears.github.io 是 GitHub 用户主站，根路径 /，无需 base
export default defineConfig({
  site: 'https://oldyears.github.io',
  output: 'static',
});
