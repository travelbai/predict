// Cloudflare Pages Function — proxies /api/dashboard to the Worker.
// Runs at the edge alongside the static Pages site.
export async function onRequest() {
  return fetch("https://predict-worker.taoflow.workers.dev/api/dashboard");
}
