import { randomBytes } from "node:crypto";

console.log(`BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`);
console.log(`TALLY_SETUP_TOKEN=${randomBytes(48).toString("base64url")}`);
console.log(`TALLY_DATA_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
