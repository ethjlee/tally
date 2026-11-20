import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { build, context } from "esbuild";

const shellPath = resolve("public/tally.html");
const shellScript = /\/tally-v(\d+)\.js(?=" defer)/;
const firstShellVersion = 7;
const versionedShells = {
  name: "versioned-shells",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]client[\\/]main\.js$/ }, async ({ path }) => ({
      contents: await readFile(path),
      resolveDir: dirname(path),
      watchFiles: [shellPath]
    }));
    builder.onEnd(async ({ errors }) => {
      if (errors.length) return;
      const html = await readFile(shellPath, "utf8");
      const current = Number(html.match(shellScript)?.[1]);
      if (!Number.isSafeInteger(current) || current < firstShellVersion) {
        throw new Error("Tally's HTML shell must reference its versioned script.");
      }
      // Older workers refill their caches using the versioned URLs they installed with.
      const versions = Array.from({ length: current - firstShellVersion + 1 }, (_, i) => firstShellVersion + i);
      await Promise.all(versions.map(version => writeFile(
        `public/tally-v${version}.html`, html.replace(shellScript, `/tally-v${version}.js`)
      )));
    });
  }
};

// The shell and older installed workers both load one classic script. The
// entry module has no exports, so the bundled result needs no module loader.
const options = {
  entryPoints: ["client/main.js"],
  outfile: "public/assets/ledger.js",
  bundle: true,
  format: "esm",
  treeShaking: false,
  target: "es2022",
  charset: "utf8",
  logLevel: "info",
  plugins: [versionedShells]
};

if (process.argv[2] === "--dev") {
  const bundler = await context(options);
  try {
    await bundler.rebuild();
    await bundler.watch();
    const require = createRequire(import.meta.url);
    const server = spawn(process.execPath, [
      require.resolve("next/dist/bin/next"), "dev", ...process.argv.slice(3)
    ], { stdio: "inherit" });
    const stop = () => server.kill();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.exitCode = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.once("exit", code => resolve(code ?? 0));
    });
  } finally {
    await bundler.dispose();
  }
} else {
  await build(options);
}
