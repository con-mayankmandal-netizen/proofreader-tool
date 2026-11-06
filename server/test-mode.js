// Zero-config test mode: runs the full tool on your own machine with the
// local file-backed store — no MongoDB server, no Atlas account, nothing
// to install beyond `npm install`. Tasks and files live in ./.testdata/
// and survive restarts of the server (delete that folder to reset).
// Your model key still comes from your local .env (git-ignored).
process.env.MODEL_PROVIDER = process.env.MODEL_PROVIDER || "mistral";
console.log("[test-mode] local storage in ./.testdata (production uses MongoDB via MONGODB_URI)");
console.log(`[test-mode] provider: ${process.env.MODEL_PROVIDER} (key read from .env / environment)`);
await import("./index.js");
