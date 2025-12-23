/* eslint-disable */

/**
 * Cloudflare Pages/Workers: root _worker.js
 * 功能：
 * 1) 全站 Basic Auth 密码保护（读取 env.PASSWORD）
 * 2) 根路径 / 返回输入框页面
 * 3) /<url> 代理请求到目标 url，并处理重定向与 HTML 相对路径
 * 4) 禁用缓存 + CORS
 */

// ✅ 监听 fetch
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request, event));
});

/**
 * ✅ Basic Auth 校验
 * - 用户名固定 admin
 * - 密码来自 env.PASSWORD
 */
function checkAuth(request, env) {
  const pwd = env && env.PASSWORD;

  // 没配置 PASSWORD：直接报错提示
  if (!pwd) return { ok: false, reason: "PASSWORD not set" };

  const auth = request.headers.get("Authorization") || "";
  const expected = "Basic " + btoa("admin:" + pwd);

  if (auth !== expected) return { ok: false, reason: "Auth required" };
  return { ok: true };
}

async function handleRequest(request, event) {
  try {
    // ✅ Pages/Workers 运行时 env 获取（兼容写法）
    const env = event?.env || event?.context?.env || {};

    // ✅ 全站开启访问控制（如果你想只保护 / 主页，也可以改条件）
    const auth = checkAuth(request, env);
    if (!auth.ok) {
      if (auth.reason === "PASSWORD not set") {
        return new Response(
          "PASSWORD not set in Cloudflare Pages/Workers environment variables.",
          {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        );
      }
      return new Response("Auth required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Protected"' },
      });
    }

    const url = new URL(request.url);

    // ✅ 访问根目录：返回 HTML
    if (url.pathname === "/") {
      return new Response(getRootHtml(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // ✅ 从请求路径中提取目标 URL（去掉开头 /）
    let actualUrlStr = decodeURIComponent(url.pathname.replace(/^\//, ""));

    // ✅ 如果用户未写协议，默认使用当前站点协议（https）
    actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);

    // ✅ 保留查询参数
    actualUrlStr += url.search;

    // ✅ 过滤 cf-* 请求头，避免 Cloudflare 内部头干扰
    const newHeaders = filterHeaders(request.headers, (name) => {
      const n = String(name || "").toLowerCase();
      return !n.startsWith("cf-");
    });

    // ✅ 构造代理请求（注意：GET/HEAD 不要带 body）
    const method = request.method || "GET";
    const init = {
      headers: newHeaders,
      method,
      redirect: "manual",
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = request.body;
    }

    const modifiedRequest = new Request(actualUrlStr, init);

    // ✅ 发起到目标 URL 的请求
    const response = await fetch(modifiedRequest);

    // ✅ 处理重定向（改写 Location 为本代理路径）
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return handleRedirect(response);
    }

    // ✅ HTML 内容处理：改写相对路径（href/src/action="/xxx"）
    let body = response.body;
    const ct = response.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      body = await handleHtmlContent(response, url.protocol, url.host, actualUrlStr);
    }

    // ✅ 创建最终响应（复制原响应头）
    const modifiedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });

    // ✅ 禁用缓存
    setNoCacheHeaders(modifiedResponse.headers);

    // ✅ CORS
    setCorsHeaders(modifiedResponse.headers);

    return modifiedResponse;
  } catch (error) {
    return jsonResponse(
      {
        error: (error && error.message) ? error.message : String(error),
      },
      500
    );
  }
}

// ✅ 确保 URL 带有协议
function ensureProtocol(url, defaultProtocol) {
  if (!url) return defaultProtocol + "//";
  return url.startsWith("http://") || url.startsWith("https://")
    ? url
    : defaultProtocol + "//" + url;
}

// ✅ 处理重定向：改写 Location 头，让它继续走代理
function handleRedirect(response) {
  const headers = new Headers(response.headers);
  const locationValue = headers.get("location") || headers.get("Location");

  if (!locationValue) {
    // 没有 location 就原样返回
    const r = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    setNoCacheHeaders(r.headers);
    setCorsHeaders(r.headers);
    return r;
  }

  let modifiedLocation = locationValue;

  try {
    // 如果是绝对 URL
    const locUrl = new URL(locationValue);
    modifiedLocation = `/${encodeURIComponent(locUrl.toString())}`;
  } catch {
    // 如果是相对路径，比如 /login 或 ./a
    // 这里简单处理：直接 encode 后拼到 / 前面
    modifiedLocation = `/${encodeURIComponent(locationValue)}`;
  }

  headers.set("Location", modifiedLocation);

  const r = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  setNoCacheHeaders(r.headers);
  setCorsHeaders(r.headers);
  return r;
}

// ✅ 处理 HTML：改写相对路径
async function handleHtmlContent(response, protocol, host, actualUrlStr) {
  const originalText = await response.text();
  const origin = new URL(actualUrlStr).origin;

  // 把 href="/xxx" src="/xxx" action="/xxx" 改成 href="https://yourhost/https://target-origin/xxx"
  return replaceRelativePaths(originalText, protocol, host, origin);
}

function replaceRelativePaths(text, protocol, host, origin) {
  // 匹配：href="/", src="/", action="/"
  const regex = new RegExp('((href|src|action)=["\'])/(?!/)', "g");
  return text.replace(regex, `$1${protocol}//${host}/${origin}/`);
}

// ✅ JSON 响应
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ✅ 过滤请求头
function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

// ✅ 禁用缓存
function setNoCacheHeaders(headers) {
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
}

// ✅ CORS
function setCorsHeaders(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
}

// ✅ 根目录 HTML
function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html { height: 100%; margin: 0; }
      .background {
          background-image: url('https://imgapi.cn/bing.php');
          background-size: cover;
          background-position: center;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.8);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .card:hover {
          background-color: rgba(255, 255, 255, 1);
          box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.3);
      }
      .input-field input[type=text] { color: #2c3e50; }
      .input-field input[type=text]:focus+label { color: #2c3e50 !important; }
      .input-field input[type=text]:focus {
          border-bottom: 1px solid #2c3e50 !important;
          box-shadow: 0 1px 0 0 #2c3e50 !important;
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align">Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          const currentOrigin = window.location.origin;
          window.open(currentOrigin + '/' + encodeURIComponent(targetUrl), '_blank');
      }
  </script>
</body>
</html>`;
}
