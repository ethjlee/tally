// The Codex sandbox does not expose the OS hook Node uses for resident-set
// memory. This preload is used only by the local build verification command;
// Vercel and normal Windows development do not need it.
const originalMemoryUsage = process.memoryUsage;
const os = require("node:os");
function safeMemoryUsage() {
  try {
    return originalMemoryUsage();
  } catch {
    return {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0
    };
  }
}
safeMemoryUsage.rss = () => {
  try {
    return originalMemoryUsage.rss();
  } catch {
    return 0;
  }
};
process.memoryUsage = safeMemoryUsage;

const originalNetworkInterfaces = os.networkInterfaces;
os.networkInterfaces = () => {
  try {
    return originalNetworkInterfaces();
  } catch {
    return {
      loopback: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8"
        }
      ]
    };
  }
};
