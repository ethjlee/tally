const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const nextCli = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const port = 3461;
const server = spawn(process.execPath, [nextCli, "start", "-p", String(port)], {
  cwd: projectRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", (chunk) => { output += chunk.toString(); });
server.stderr.on("data", (chunk) => { output += chunk.toString(); });

function waitForReady(timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (output.includes("Ready")) {
        clearInterval(timer);
        resolve();
      } else if (server.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`Production server exited early:\n${output}`));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Production server did not become ready:\n${output}`));
      }
    }, 25);
  });
}

(async () => {
  try {
    await waitForReady();
    const shell = await fetch(`http://127.0.0.1:${port}/tally.html`);
    assert.equal(shell.status, 200);
    const csp = shell.headers.get("content-security-policy") || "";
    const scriptDirective = csp.split(";").find((part) => part.trim().startsWith("script-src")) || "";
    assert.equal(scriptDirective.includes("unsafe-inline"), false);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(shell.headers.get("x-robots-tag") || "", /noindex/);
    assert.match(shell.headers.get("cache-control") || "", /no-cache/);
    const markup = await shell.text();
    assert.match(markup, /Checking private ledger/);
    const clientPath = markup.match(/<script src="(\/tally-v\d+\.js)" defer>/)?.[1];
    assert.ok(clientPath, "The Tally shell references a versioned client asset");
    const client = await fetch(`http://127.0.0.1:${port}${clientPath}`);
    assert.equal(client.status, 200);
    assert.match(client.headers.get("content-type") || "", /javascript/);
    assert.match(await client.text(), /function loadAll\(\)/);
    const precachePath = clientPath.replace(/\.js$/, ".html");
    const precachePage = await fetch(`http://127.0.0.1:${port}${precachePath}`);
    assert.equal(precachePage.status, 200);
    assert.equal(await precachePage.text(), markup);

    const worker = await fetch(`http://127.0.0.1:${port}/sw.js`);
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get("service-worker-allowed"), "/");
    assert.match(worker.headers.get("cache-control") || "", /no-store/);
    const workerCode = await worker.text();
    assert.match(workerCode, /mustNeverCache/);
    assert.ok(workerCode.includes(JSON.stringify(clientPath)), "The worker precaches the same versioned client asset");
    assert.ok(workerCode.includes(JSON.stringify(precachePath)), "The worker precaches the matching versioned HTML");

    console.log("Production header and static-shell smoke test passed.");
  } finally {
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
