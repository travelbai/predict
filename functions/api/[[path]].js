// Cloudflare Pages Function — proxies all /api/* requests to the Worker.
export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const workerUrl = "https://predict-worker.taoflow.workers.dev" + url.pathname + url.search;
  return fetch(workerUrl, ctx.request);
}
