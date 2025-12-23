export default {
  async fetch(request, env) {
    // 1) 必须先有 PASSWORD
    const pwd = env?.PASSWORD;
    if (!pwd) {
      return new Response("PASSWORD not set in Cloudflare Pages environment.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // 2) Basic Auth（浏览器会弹框）
    const auth = request.headers.get("Authorization") || "";
    const expected = "Basic " + btoa("admin:" + pwd);

    if (auth !== expected) {
      return new Response("Auth required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Protected"' },
      });
    }

    // 3) 通过鉴权后，把请求交给 Pages 静态资源（这一步很关键）
    // Cloudflare Pages 默认会注入 ASSETS 绑定
    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // 兜底（一般不会走到这）
    return new Response("ASSETS binding not found.", { status: 500 });
  },
};
