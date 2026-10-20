import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [reactRouter()]),
  resolve: {
    tsconfigPaths: true,
  },
  // Listen on all addresses, so phones on the local network can open the site.
  server: { host: true },
  preview: { host: true },
});
