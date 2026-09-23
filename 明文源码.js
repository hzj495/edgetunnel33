

export const CONFIG = {
  SOURCES: [
    {
      name: '项目1',
      type: 'code1',
      url: '', // 例如：https://a.example.com/你的UUID
      enabled: true,
    },
    {
      name: '项目2',
      type: 'code2',
      url: 'https://css.junkayk.com/1c6a16fc-a078-4aed-a464-b41e6e4e7851', // 例如：https://b.example.com/你的UUID
      enabled: true,
    },
  ],

  // Clash Verge / Mihomo 中显示的订阅名称，直接在这里修改即可。
  SUBSCRIPTION_NAME: 'kaa',

  FETCH_TIMEOUT: 12000,
};

const SUPPORTED_URI_SCHEMES = new Set(['vless', 'trojan']);
const SUPPORTED_TRANSPORTS = new Set(['ws', 'xhttp']);

// V6.17：Clash 优先使用项目1同款订阅转换后端 + ACL4SSR 配置，
// 从而继承项目1的代理组与分流；转换器异常时仍回退到本地标准 YAML。
const DEFAULT_SUBAPI = 'https://SubApi.CmliUsssS.Net';
const SUBCONFIG = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Mini_MultiMode.ini';
const SUBPROTOCOL = 'https';
const SUBEMOJI = 'true';
const SUBSCV = 'false';

export default {
  async fetch(request, env = {}, ctx) {
    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);
      const accessKey = String(env.UUID || env.uuid || '').trim();

      if (!accessKey) {
        return text('请设置 Cloudflare 环境变量 UUID，它将作为中控访问和订阅路径密钥。', 503, {
          'Cache-Control': 'no-store',
        });
      }

      // EXPIRY_DATE 对 H5、订阅和已经下发的 Relay 节点同时生效。
      const expiry = getExpiryState(env.EXPIRY_DATE);
      if (!expiry.valid) {
        return text(expiry.message, 403, { 'Cache-Control': 'no-store' });
      }

      // 所有节点实际使用时都会访问 /relay/...，因此到期后旧节点也会在这里被拦截。
      if (path.startsWith('/relay/')) {
        return handleRelay(request, url, env);
      }

      const keyPath = `/${accessKey}`;
      const statusPath = `${keyPath}/status.json`;
      const diagnosePath = `${keyPath}/diagnose`;
      const mergeSourcePath = `${keyPath}/merge-source`;
      const convertTestPath = `${keyPath}/convert-test`;

      // V6.5：专供项目1原版 SubAPI 读取的内部 Base64 合并源。
      // 与 cs(4).txt 的 /fakeUserID/merge-code2 作用一致，避免转换器再次触发 Clash/SingBox/Loon 格式分支。
      if (path === mergeSourcePath) {
        const internalUrl = new URL(request.url);
        internalUrl.pathname = keyPath;
        for (const key of ['clash', 'singbox', 'sb', 'loon', 'b64', 'base64', 'raw', 'plain', 'target']) {
          internalUrl.searchParams.delete(key);
        }
        internalUrl.searchParams.set('b64', '');
        return handleMergedSubscription(request, internalUrl, env, expiry);
      }

      if (path === statusPath) {
        return handleStatus(request, env);
      }

      if (path === convertTestPath) {
        return handleConvertTest(request, env, expiry, keyPath);
      }

      if (path === diagnosePath) {
        return handleDiagnose(request, env);
      }

      if (path === keyPath) {
        // 自 V6.14 起：不能只靠 Mozilla UA 判断 H5。
        // 一些定制 Clash 前端/重试下载会使用 Chromium/Mozilla UA，但它们不是页面导航。
        // 只有真正的浏览器 document/navigate（或明确 Accept: text/html）才显示 H5；其余按订阅处理。
        if (shouldShowH5(request, url)) {
          return h5Page(request, env, expiry);
        }
        return handleMergedSubscription(request, url, env, expiry);
      }

      return text('不用怀疑！你的地址输入错误！！！', 404, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return text(`Internal Error: ${error?.message || error}`, 500, { 'Cache-Control': 'no-store' });
    }
  },
};

function normalizePath(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function configuredSources() {
  const out = [];
  for (let i = 0; i < CONFIG.SOURCES.length; i++) {
    const s = CONFIG.SOURCES[i] || {};
    if (s.enabled === false) continue;
    const raw = String(s.url || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      out.push({ ...s, _index: i, url: u.toString() });
    } catch {}
  }
  return out;
}

async function handleMergedSubscription(request, currentUrl, env = {}, expiry = getExpiryState(env.EXPIRY_DATE)) {
  const sources = configuredSources();
  if (!sources.length) {
    return text('中控尚未配置源订阅 URL。请编辑代码顶部 CONFIG.SOURCES。', 503, {
      'Cache-Control': 'no-store',
    });
  }

  const fetched = await Promise.all(sources.map(source => fetchOneSource(source, request)));
  const centralHost = currentUrl.hostname;
  // 先完成两个源项目的 Relay 重写，但暂不写入最终订阅。
  // 这样 ADD 可以使用其中一条 Relay 作为模板，并且最终顺序能够固定为：ADD -> 项目1 -> 项目2。
  const sourceOutput = [];
  const sourceSeen = new Set();
  const failures = [];
  let unsupported = 0;
  let successfulSources = 0;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const result = fetched[i];
    if (!result.nodes.length) {
      failures.push(`${source.name}: ${result.error || '未识别到节点'}`);
      continue;
    }
    successfulSources++;

    for (const original of result.nodes) {
      let rewritten = await rewriteNodeToCentral(original, source, centralHost, env);
      if (!rewritten) {
        unsupported++;
        continue;
      }
      const key = canonicalNodeKey(rewritten);
      if (!key || sourceSeen.has(key)) continue;
      sourceSeen.add(key);
      sourceOutput.push(rewritten);
    }
  }

  const output = [];
  const seenSourceConnections = new Set();
  const seenExactAddNodes = new Set();

  // ADD 与项目1相同概念：作为额外优选入口，真正加入最终订阅。
  // V5.8：每一条 ADD 都按“完整节点（含备注）”保留；即使 server/port 相同但备注不同也不会被压成 1 条。
  // 同时记录 ADD 的连接字段，用于随后跳过与 ADD 完全同连接的源项目节点，保证 ADD 始终排在最前。
  const addEntries = parseAddEntries(env.ADD);
  const addTemplate = sourceOutput.find(isUriRelayNode) || '';
  let addGenerated = 0;
  if (addTemplate && addEntries.length) {
    for (const entry of addEntries) {
      const addNode = cloneAddNode(addTemplate, entry, centralHost);
      if (!addNode) continue;
      const exactKey = String(addNode).trim();
      if (!exactKey || seenExactAddNodes.has(exactKey)) continue;
      seenExactAddNodes.add(exactKey);
      const connectionKey = canonicalNodeKey(addNode);
      if (connectionKey) seenSourceConnections.add(connectionKey);
      output.push(addNode);
      addGenerated++;
    }
  }

  // ADD 写入完成后，再按 CONFIG.SOURCES 的顺序追加项目1、项目2。
  for (const sourceNode of sourceOutput) {
    const key = canonicalNodeKey(sourceNode);
    if (!key || seenSourceConnections.has(key)) continue;
    seenSourceConnections.add(key);
    output.push(sourceNode);
  }

  if (!output.length) {
    return text(
      `没有生成可通过中控转发的节点。\n` +
      `当前强制失效模式支持：VLESS/Trojan 的 WS、XHTTP，以及 VMess-WS。\n` +
      failures.join('\n'),
      502,
      { 'Cache-Control': 'no-store' },
    );
  }

  const target = determineSubscriptionTarget(request, currentUrl);
  try {
    console.log('[V6.17 subscription-detect]', JSON.stringify({
      ua: String(request.headers.get('User-Agent') || '').slice(0, 240),
      accept: String(request.headers.get('Accept') || '').slice(0, 160),
      secFetchMode: String(request.headers.get('Sec-Fetch-Mode') || ''),
      secFetchDest: String(request.headers.get('Sec-Fetch-Dest') || ''),
      target,
    }));
  } catch {}
  const formatted = await formatMergedSubscriptionAdaptive(output, target, currentUrl, request, env);
  const body = formatted.body;
  const profileWebPageUrl = `${currentUrl.protocol}//${currentUrl.host}${currentUrl.pathname}`;
  const subscriptionName = String(CONFIG.SUBSCRIPTION_NAME || 'subscription').trim() || 'subscription';
  const asciiSubscriptionName = subscriptionName
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '') || 'subscription';
  const dispositionName = encodeURIComponent(subscriptionName);

  const headers = {
    'Content-Type': formatted.contentType,
    'Content-Disposition': `attachment; filename=${asciiSubscriptionName}; filename*=utf-8''${dispositionName}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Profile-Update-Interval': '6',
    'Profile-web-page-url': profileWebPageUrl,
    'Subscription-Userinfo': `upload=0; download=0; total=0; expire=${expiry.expireTimestamp || 4102329600}`,
    'X-Central-Node-Count': String(output.length),
    'X-Central-Source-Count': String(successfulSources),
    'X-Central-Failed-Count': String(failures.length),
    'X-Central-Skipped-Unsupported': String(unsupported),
    'X-Central-Relay-Required': 'true',
    'X-Central-ADD-Count': String(addGenerated),
    'X-Central-Detected-Target': target,
    'X-Central-Route-Mode': 'subscription',
    'X-Central-Version': 'V6.17',
  };
  if (failures.length) {
    headers['X-Central-Warnings'] = encodeURIComponent(failures.join(' | ')).slice(0, 1400);
  }
  if (formatted.engine) headers['X-Central-Format-Engine'] = formatted.engine;
  if (formatted.converterStatus !== undefined) headers['X-Central-Subconverter-Status'] = String(formatted.converterStatus);
  if (formatted.converterError) headers['X-Central-Subconverter-Error'] = encodeURIComponent(formatted.converterError).slice(0, 700);

  // V6.16 Clash：优先返回项目1同款 ACL4SSR 配置，并使用可自定义订阅名称。
  if (target === 'clash') {
    headers['Content-Type'] = formatted.contentType || 'text/yaml; charset=utf-8';
    headers['Content-Disposition'] = `attachment; filename=${asciiSubscriptionName}; filename*=utf-8''${encodeURIComponent(subscriptionName)}`;
    headers['Cache-Control'] = 'no-store';
    headers['X-Central-Clash-Transport'] = formatted.engine === 'project1-subconverter' ? 'project1-acl4ssr' : 'standard-yaml-fallback';
    headers['X-Central-Version'] = 'V6.17';

    const clashText = String(body || '');
    const hasProxies = /(^|\n)proxies\s*:/m.test(clashText);
    const hasProxyGroups = /(^|\n)proxy-groups\s*:/m.test(clashText);
    const hasRules = /(^|\n)rules\s*:/m.test(clashText);
    const hasEncryption = /^\s+encryption\s*:/m.test(clashText);
    const clashNodeCount = uniqueParsedNodes(output).filter(p => p.network === 'ws').length;
    headers['X-Central-Clash-Node-Count'] = String(clashNodeCount);
    headers['X-Central-Clash-YAML'] = (hasProxies && hasProxyGroups && hasRules) ? 'true' : 'false';
    try {
      console.log('[V6.17 clash-response]', JSON.stringify({
        status: formatted.status || 200,
        bytes: new TextEncoder().encode(clashText).byteLength,
        nodeCount: clashNodeCount,
        hasProxies,
        hasProxyGroups,
        hasRules,
        hasEncryption,
        bodyPrefix: clashText.slice(0, 24),
        engine: formatted.engine || '',
      }));
    } catch {}
  }
  return new Response(body, { status: formatted.status || 200, headers });
}

function shouldShowH5(request, currentUrl) {
  if (hasSubscriptionQuery(currentUrl)) return false;

  const headers = request?.headers;
  const ua = String(headers?.get('User-Agent') || '').toLowerCase();
  const accept = String(headers?.get('Accept') || '').toLowerCase();
  const fetchMode = String(headers?.get('Sec-Fetch-Mode') || '').toLowerCase();
  const fetchDest = String(headers?.get('Sec-Fetch-Dest') || '').toLowerCase();

  // 已知订阅客户端永远优先按订阅处理，即便外层壳带 Mozilla 字样。
  if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('verge') ||
      ua.includes('shadowrocket') || ua.includes('v2ray') || ua.includes('nekobox') ||
      ua.includes('nekoray') || ua.includes('hiddify') || ua.includes('sing-box') ||
      ua.includes('singbox') || ua.includes('loon') || ua.includes('cf-workers-sub') ||
      ua.includes('subconverter') || ua.includes('go-http-client')) {
    return false;
  }

  // Chromium/WebView 的 fetch() 通常是 cors/empty；真正地址栏打开则是 navigate/document。
  // 一旦浏览器提供了 Sec-Fetch-*，就以它为准，避免 WebView fetch 即使 Accept 带 text/html 也被误判成页面。
  if (fetchMode || fetchDest) {
    return fetchMode === 'navigate' || fetchDest === 'document';
  }
  // 兼容旧浏览器：没有 Sec-Fetch-* 时，才退回 Mozilla + text/html 判断。
  return ua.includes('mozilla') && accept.includes('text/html');
}

function determineSubscriptionTarget(request, currentUrl) {
  const params = currentUrl.searchParams;
  const explicitTarget = String(params.get('target') || '').trim().toLowerCase();
  if (params.has('raw') || params.has('plain') || ['raw', 'plain'].includes(explicitTarget)) return 'raw';
  if (params.has('clash') || ['clash', 'clashmeta', 'mihomo'].includes(explicitTarget)) return 'clash';
  if (params.has('singbox') || params.has('sb') || ['singbox', 'sing-box', 'sb'].includes(explicitTarget)) return 'singbox';
  if (params.has('loon') || explicitTarget === 'loon') return 'loon';
  if (params.has('b64') || params.has('base64') || ['base64', 'b64', 'v2ray'].includes(explicitTarget)) return 'base64';

  // 与项目1相同概念：不要求用户给 /UUID 额外拼格式参数，按客户端 UA 自适应返回。
  const ua = String(request?.headers?.get('User-Agent') || '').toLowerCase();
  if (ua.includes('cf-workers-sub') || ua.includes('subconverter')) return 'base64';
  // Clash Verge 1.5.x 曾出现默认 UA=Go-http-client/1.1；部分定制版也不含 clash 字样。
  // 因此兼容这些历史/定制 UA，同时保留常见 Base64 客户端识别。
  if (ua.includes('shadowrocket') || ua.includes('v2ray') || ua.includes('nekobox') || ua.includes('nekoray') || ua.includes('hiddify')) return 'base64';
  if ((ua.includes('clash') && !ua.includes('nekobox')) || ua.includes('mihomo') || ua.includes('verge') || ua.includes('go-http-client')) return 'clash';
  if (ua.includes('sing-box') || ua.includes('singbox')) return 'singbox';
  if (ua.includes('loon')) return 'loon';
  // 非浏览器、又无法识别的客户端默认按 Clash 返回；避免旧版/定制 Clash 使用非标准 UA 时拿到 Base64。
  return 'clash';
}

async function formatMergedSubscriptionAdaptive(nodes, target, currentUrl, request, env = {}) {
  const normalized = String(target || 'base64').toLowerCase();

  // V6.17：Clash 优先走项目1相同的 SubAPI + ACL4SSR_Online_Mini_MultiMode.ini，
  // 这样代理组、自动选择、故障转移、负载均衡以及分流规则都与项目1同源。
  // 若外部转换器异常，则回退 V6.14 已验证可导入的本地标准 YAML。
  if (normalized === 'clash') {
    const remote = await formatViaProject1Subconverter('clash', currentUrl, request, env);
    if (remote.status === 200) return remote;
    return {
      body: buildClashYaml(nodes),
      contentType: 'text/yaml; charset=utf-8',
      status: 200,
      engine: 'central-clash-yaml-fallback-v615',
      converterStatus: remote.converterStatus || 0,
      converterError: String(remote.body || '').slice(0, 300),
    };
  }
  if (['singbox', 'loon'].includes(normalized)) {
    const remote = await formatViaProject1Subconverter(normalized, currentUrl, request, env);
    if (remote.status === 200) return remote;
    const local = formatMergedSubscription(nodes, normalized);
    return {
      ...local,
      status: 200,
      engine: 'central-local-fallback',
      converterStatus: remote.converterStatus || 0,
      converterError: String(remote.body || '').slice(0, 300),
    };
  }

  const local = formatMergedSubscription(nodes, normalized);
  return { ...local, status: 200, engine: normalized === 'raw' ? 'central-raw' : 'central-base64' };
}

function resolveSubapi(env = {}) {
  let raw = String(env.SUBAPI || env.subapi || DEFAULT_SUBAPI || '').trim();
  if (!raw || /^(off|false|0|none)$/i.test(raw)) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    // sub.cmliussss.net 是 WorkerVless2sub 订阅生成器，不支持 target=clash&url=... 这套 SubAPI 参数。
    if (u.hostname.toLowerCase() === 'sub.cmliussss.net') return '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    if (!u.pathname || u.pathname === '/') u.pathname = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function buildProject1ConverterUrl(target, currentUrl, request, env = {}) {
  const base = resolveSubapi(env);
  if (!base) return '';

  const sourceUrl = new URL(currentUrl.toString());
  sourceUrl.pathname = `${normalizePath(currentUrl.pathname)}/merge-source`;
  sourceUrl.search = '';

  const original = new URL(request.url);
  for (const [key, value] of original.searchParams.entries()) {
    if (['clash', 'singbox', 'sb', 'loon', 'b64', 'base64', 'raw', 'plain', 'target'].includes(key.toLowerCase())) continue;
    sourceUrl.searchParams.append(key, value);
  }

  const converter = new URL(`${base.replace(/\/$/, '')}/sub`);
  converter.searchParams.set('target', target === 'singbox' ? 'singbox' : target);
  converter.searchParams.set('url', sourceUrl.toString());
  converter.searchParams.set('insert', 'false');
  converter.searchParams.set('config', String(env.SUBCONFIG || env.subconfig || SUBCONFIG).trim() || SUBCONFIG);
  converter.searchParams.set('emoji', SUBEMOJI);
  converter.searchParams.set('list', 'false');
  converter.searchParams.set('tfo', 'false');
  converter.searchParams.set('scv', SUBSCV);
  converter.searchParams.set('fdn', 'false');
  converter.searchParams.set('sort', 'false');
  converter.searchParams.set('new_name', 'true');
  return converter.toString();
}

async function formatViaProject1Subconverter(target, currentUrl, request, env = {}) {
  let converterUrl = '';
  try {
    converterUrl = buildProject1ConverterUrl(target, currentUrl, request, env);
    if (!converterUrl) {
      return {
        status: 503,
        body: '外部 SubAPI 未配置或配置的是 sub.cmliussss.net 订阅生成器，已交由本地转换兜底。',
        contentType: 'text/plain; charset=utf-8',
        engine: 'project1-subconverter-disabled',
        converterStatus: 0,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(CONFIG.FETCH_TIMEOUT) || 12000);
    let response;
    try {
      response = await fetch(converterUrl, {
        signal: controller.signal,
        headers: {
          // 与项目1 cs(4).txt 相同的转换器请求 UA。
          'User-Agent': 'v2rayN/edgetunnel (https://github.com/cmliu/edgetunnel)',
          'Accept': 'text/plain,*/*',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();
    if (!response.ok) {
      return {
        status: 502,
        body: `订阅转换失败：SubAPI HTTP ${response.status}。`,
        contentType: 'text/plain; charset=utf-8',
        engine: 'project1-subconverter-error',
        converterStatus: response.status,
      };
    }

    const trimmed = String(body || '').trim();
    if (!trimmed || /^error\b/i.test(trimmed) || /^failed\b/i.test(trimmed)) {
      return {
        status: 502,
        body: `订阅转换失败：SubAPI 返回了无效内容。\n${trimmed.slice(0, 300)}`.trim(),
        contentType: 'text/plain; charset=utf-8',
        engine: 'project1-subconverter-error',
        converterStatus: response.status,
      };
    }

    if (target === 'clash' && !/(^|\n)proxies\s*:/m.test(trimmed)) {
      return {
        status: 502,
        body: '订阅转换失败：SubAPI 没有返回 Clash 配置（缺少 proxies:）。',
        contentType: 'text/plain; charset=utf-8',
        engine: 'project1-subconverter-error',
        converterStatus: response.status,
      };
    }

    if (target === 'singbox') {
      try {
        JSON.parse(trimmed);
      } catch {
        return {
          status: 502,
          body: '订阅转换失败：SubAPI 没有返回有效的 SingBox JSON。',
          contentType: 'text/plain; charset=utf-8',
          engine: 'project1-subconverter-error',
          converterStatus: response.status,
        };
      }
    }

    const contentType = response.headers.get('content-type') || (
      target === 'clash'
        ? 'text/yaml; charset=utf-8'
        : target === 'singbox'
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8'
    );

    return {
      status: 200,
      body,
      contentType,
      engine: 'project1-subconverter',
      converterStatus: response.status,
    };
  } catch (error) {
    return {
      status: 502,
      body: `订阅转换失败：${error?.name === 'AbortError' ? 'SubAPI 请求超时' : (error?.message || error)}`,
      contentType: 'text/plain; charset=utf-8',
      engine: 'project1-subconverter-error',
      converterStatus: 0,
    };
  }
}

async function handleConvertTest(request, env = {}, expiry = getExpiryState(env.EXPIRY_DATE), keyPath = '') {
  const url = new URL(request.url);
  const basePath = keyPath || `/${String(env.UUID || env.uuid || '').trim()}`;
  const testUrl = new URL(request.url);
  testUrl.pathname = basePath;
  testUrl.search = '?b64';

  // 直接调用中控合并函数，先验证 ADD + 项目1 + 项目2 的 Base64 源，无需通过公网回环请求自己。
  let mergedResponse;
  let mergedText = '';
  let nodes = [];
  let mergedStatus = 0;
  try {
    mergedResponse = await handleMergedSubscription(request, testUrl, env, expiry);
    mergedStatus = mergedResponse.status;
    mergedText = await mergedResponse.text();
    const decoded = tryDecodeBase64(mergedText) || '';
    nodes = extractNodes(decoded);
  } catch (error) {
    mergedText = String(error?.message || error);
  }

  const localYaml = buildClashYaml(nodes);
  const localClashNodes = uniqueParsedNodes(nodes).filter(p => p.network === 'ws');
  const localSemantic = {
    yamlLike: /(^|\n)proxies\s*:/m.test(localYaml) && /(^|\n)proxy-groups\s*:/m.test(localYaml),
    matchRuleOk: /^\s*-\s*MATCH,🐟 漏网之鱼\s*$/m.test(localYaml),
    vlessEncryptionAbsent: !/^\s+encryption\s*:/m.test(localYaml),
    wsOnlyCompat: !/^\s+network:\s*(?!ws\s*$).+/m.test(localYaml),
  };
  const localOk = mergedStatus === 200 && nodes.length > 0 && localClashNodes.length > 0 && Object.values(localSemantic).every(Boolean);

  const converterBase = resolveSubapi(env);
  let converterStatus = 0;
  let converterOk = false;
  let converterMessage = converterBase ? '未测试' : '未启用（将使用本地转换）';
  let converterUrl = '';
  if (converterBase) {
    try {
      const converterBaseUrl = new URL(request.url);
      converterBaseUrl.pathname = basePath;
      converterBaseUrl.search = '';
      converterUrl = buildProject1ConverterUrl('clash', converterBaseUrl, request, env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(CONFIG.FETCH_TIMEOUT) || 12000);
      let response;
      try {
        response = await fetch(converterUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'v2rayN/edgetunnel (https://github.com/cmliu/edgetunnel)',
            'Accept': 'text/plain,*/*',
          },
        });
      } finally {
        clearTimeout(timer);
      }
      converterStatus = response.status;
      const body = await response.text();
      converterOk = response.ok && /(^|\n)proxies\s*:/m.test(body);
      converterMessage = converterOk ? '正常' : `异常：HTTP ${response.status}`;
    } catch (error) {
      converterMessage = error?.name === 'AbortError' ? '请求超时' : String(error?.message || error);
    }
  }

  const result = {
    version: 'V6.17',
    mergedSource: {
      ok: mergedStatus === 200 && nodes.length > 0,
      httpStatus: mergedStatus,
      nodeCount: nodes.length,
    },
    externalSubapi: {
      configured: !!converterBase,
      base: converterBase || '',
      httpStatus: converterStatus,
      ok: converterOk,
      message: converterMessage,
    },
    localClashFallback: {
      ok: localOk,
      nodeCount: nodes.length,
      containsProxies: /(^|\n)proxies\s*:/m.test(localYaml),
      containsProxyGroups: /(^|\n)proxy-groups\s*:/m.test(localYaml),
      containsRules: /(^|\n)rules\s*:/m.test(localYaml),
      semantic: localSemantic,
    },
  };

  if (url.searchParams.has('json')) {
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const esc = value => String(value ?? '').replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅转换诊断</title><style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f7f9;margin:0;color:#253047}.wrap{max-width:850px;margin:32px auto;padding:0 16px}.card{background:#fff;border-radius:16px;padding:22px;margin:14px 0;box-shadow:0 4px 14px #00000012}.ok{color:#079455}.bad{color:#d92d20}.muted{color:#667085}.row{display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid #eef1f5;padding:11px 0}.row:last-child{border-bottom:0}code{word-break:break-all}</style></head><body><div class="wrap"><div class="card"><h2>中控订阅转换诊断 · V6.17</h2><p class="muted">V6.16 的 Clash 优先使用项目1同款 ACL4SSR 转换配置，继承项目1代理组与分流；转换失败时回退本地标准 YAML。</p></div><div class="card"><h3>合并源</h3><div class="row"><span>HTTP</span><b>${mergedStatus}</b></div><div class="row"><span>节点数</span><b>${nodes.length}</b></div><div class="row"><span>状态</span><b class="${result.mergedSource.ok?'ok':'bad'}">${result.mergedSource.ok?'正常':'异常'}</b></div></div><div class="card"><h3>外部 SubAPI</h3><div class="row"><span>地址</span><code>${esc(converterBase || '未启用')}</code></div><div class="row"><span>HTTP</span><b>${converterStatus || '-'}</b></div><div class="row"><span>状态</span><b class="${converterOk?'ok':'bad'}">${esc(converterMessage)}</b></div></div><div class="card"><h3>本地 Clash 标准 YAML 输出</h3><div class="row"><span>状态</span><b class="${localOk?'ok':'bad'}">${localOk?'可用':'异常'}</b></div><div class="row"><span>proxies / groups / rules</span><b>${result.localClashFallback.containsProxies?'✓':'✗'} / ${result.localClashFallback.containsProxyGroups?'✓':'✗'} / ${result.localClashFallback.containsRules?'✓':'✗'}</b></div><div class="row"><span>YAML结构 / FINAL分流 / encryption / XHTTP</span><b>${localSemantic.yamlLike?'✓':'✗'} / ${localSemantic.matchRuleOk?'✓':'✗'} / ${localSemantic.vlessEncryptionAbsent?'✓':'✗'} / ${localSemantic.wsOnlyCompat?'✓':'✗'}</b></div></div></div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function formatMergedSubscription(nodes, target) {
  const normalized = String(target || 'base64').toLowerCase();
  if (normalized === 'raw') {
    return { body: nodes.join('\n'), contentType: 'text/plain; charset=utf-8' };
  }
  if (normalized === 'clash') {
    return { body: buildClashYaml(nodes), contentType: 'text/yaml; charset=utf-8' };
  }
  if (normalized === 'singbox') {
    return { body: buildSingBoxJson(nodes), contentType: 'application/json; charset=utf-8' };
  }
  if (normalized === 'loon') {
    return { body: buildLoonSubscription(nodes), contentType: 'text/plain; charset=utf-8' };
  }
  return { body: utf8ToBase64(nodes.join('\n')), contentType: 'text/plain; charset=utf-8' };
}

function decodeNodeName(value, fallback = '节点') {
  let name = String(value || '').replace(/^#/, '').trim();
  try { name = decodeURIComponent(name); } catch {}
  return name || fallback;
}

function parseMergedNode(node) {
  const value = String(node || '').trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('vless://') || lower.startsWith('trojan://')) {
    let u;
    try { u = new URL(value); } catch { return null; }
    const type = u.protocol.slice(0, -1).toLowerCase();
    const network = String(u.searchParams.get('type') || 'ws').toLowerCase();
    if (!['ws', 'xhttp'].includes(network)) return null;
    const security = String(u.searchParams.get('security') || '').toLowerCase();
    return {
      type,
      name: decodeNodeName(u.hash, `${type}-${u.hostname}`),
      server: u.hostname,
      port: Number(u.port || (security === 'none' ? 80 : 443)),
      credential: decodeURIComponent(u.username || ''),
      tls: security !== 'none',
      sni: u.searchParams.get('sni') || u.searchParams.get('servername') || u.hostname,
      fp: u.searchParams.get('fp') || 'chrome',
      network,
      host: u.searchParams.get('host') || u.hostname,
      path: u.searchParams.get('path') || '/',
      flow: u.searchParams.get('flow') || '',
      alpn: u.searchParams.get('alpn') || '',
    };
  }
  if (lower.startsWith('vmess://')) {
    const decoded = tryDecodeBase64(value.slice('vmess://'.length));
    if (!decoded) return null;
    let obj;
    try { obj = JSON.parse(decoded); } catch { return null; }
    const network = String(obj.net || 'ws').toLowerCase();
    if (network !== 'ws') return null;
    const tls = String(obj.tls || '').toLowerCase() === 'tls';
    return {
      type: 'vmess',
      name: String(obj.ps || `vmess-${obj.add || 'node'}`),
      server: String(obj.add || ''),
      port: Number(obj.port || (tls ? 443 : 80)),
      credential: String(obj.id || ''),
      alterId: Number(obj.aid || 0),
      cipher: String(obj.scy || 'auto'),
      tls,
      sni: String(obj.sni || obj.host || obj.add || ''),
      fp: String(obj.fp || 'chrome'),
      network,
      host: String(obj.host || obj.add || ''),
      path: String(obj.path || '/'),
      alpn: String(obj.alpn || ''),
    };
  }
  return null;
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

function uniqueParsedNodes(nodes) {
  const parsed = [];
  const used = new Map();
  for (const raw of nodes) {
    const item = parseMergedNode(raw);
    if (!item || !item.server || !item.port || !item.credential) continue;
    // Mihomo 当前仅 VLESS 支持 XHTTP；其它协议的 XHTTP 节点跳过，避免整份配置导入失败。
    if (item.network === 'xhttp' && item.type !== 'vless') continue;
    const base = String(item.name || '节点').trim() || '节点';
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    item.name = n === 1 ? base : `${base}-${n}`;
    parsed.push(item);
  }
  return parsed;
}

function buildClashJsonProfile(nodes) {
  // 旧兼容辅助函数：保留供必要时诊断。
  const parsed = uniqueParsedNodes(nodes).filter(p => p.network === 'ws');
  const proxies = [];

  for (const p of parsed) {
    const proxy = {
      name: p.name,
      type: p.type,
      server: p.server,
      port: p.port,
    };

    if (p.type === 'trojan') proxy.password = p.credential;
    else proxy.uuid = p.credential;

    if (p.type === 'vmess') {
      proxy.alterId = p.alterId || 0;
      proxy.cipher = p.cipher || 'auto';
    }

    if (p.type === 'vless') {
      // 与项目1兼容字段保持一致，不输出 encryption。
      proxy.udp = false;
      proxy.tfo = false;
      if (p.flow) proxy.flow = p.flow;
    }

    proxy.tls = !!p.tls;
    if (p.tls) {
      if (p.type === 'vless') proxy.sni = p.sni || p.server;
      proxy.servername = p.sni || p.server;
      proxy['client-fingerprint'] = p.fp || 'chrome';
      proxy['skip-cert-verify'] = false;
    }

    proxy.network = 'ws';
    proxy['ws-opts'] = {
      path: p.path || '/',
      headers: { Host: p.host || p.server },
    };
    proxies.push(proxy);
  }

  const names = proxies.map(p => p.name);
  const config = {
    proxies,
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: names.length ? names : ['DIRECT'],
      },
    ],
    rules: ['MATCH,PROXY'],
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function buildClashYaml(nodes) {
  // V6.17 本地 Clash 输出直接内置项目1同款 ACL4SSR Mini MultiMode 代理组与分流。
  // 这样即使外部 SubAPI 不可用，也不会退回只有 PROXY + MATCH 的简化配置。
  // XHTTP 在旧内核兼容性差，Clash 兼容订阅仍只输出 WS；Base64/其它客户端保持原始节点。
  const parsed = uniqueParsedNodes(nodes).filter(p => p.network === 'ws');
  const nodeNames = parsed.map(p => p.name);
  const lines = ['mode: rule', 'proxies:'];

  for (const p of parsed) {
    lines.push(`  - name: ${yamlQuote(p.name)}`);
    lines.push(`    type: ${p.type}`);
    lines.push(`    server: ${yamlQuote(p.server)}`);
    lines.push(`    port: ${p.port}`);
    if (p.type === 'trojan') {
      lines.push(`    password: ${yamlQuote(p.credential)}`);
    } else {
      lines.push(`    uuid: ${yamlQuote(p.credential)}`);
    }
    if (p.type === 'vmess') {
      lines.push(`    alterId: ${p.alterId || 0}`);
      lines.push(`    cipher: ${yamlQuote(p.cipher || 'auto')}`);
    }
    if (p.type === 'vless') {
      lines.push('    udp: false');
      lines.push('    tfo: false');
      if (p.flow) lines.push(`    flow: ${yamlQuote(p.flow)}`);
    }
    lines.push(`    tls: ${p.tls ? 'true' : 'false'}`);
    if (p.tls) {
      if (p.type === 'vless') lines.push(`    sni: ${yamlQuote(p.sni || p.server)}`);
      lines.push(`    servername: ${yamlQuote(p.sni || p.server)}`);
      lines.push(`    client-fingerprint: ${yamlQuote(p.fp || 'chrome')}`);
      lines.push('    skip-cert-verify: false');
    }
    lines.push('    network: ws');
    lines.push('    ws-opts:');
    lines.push(`      path: ${yamlQuote(p.path || '/')}`);
    lines.push('      headers:');
    lines.push(`        Host: ${yamlQuote(p.host || p.server)}`);
  }

  const addProxyList = (items) => {
    lines.push('    proxies:');
    (items.length ? items : ['DIRECT']).forEach(name => lines.push(`      - ${yamlQuote(name)}`));
  };

  lines.push('proxy-groups:');
  lines.push(`  - name: ${yamlQuote('🚀 节点选择')}`);
  lines.push('    type: select');
  addProxyList(['♻️ 自动选择', '🔯 故障转移', '🔮 负载均衡', 'DIRECT', ...nodeNames]);

  lines.push(`  - name: ${yamlQuote('♻️ 自动选择')}`);
  lines.push('    type: url-test');
  lines.push(`    url: ${yamlQuote('http://www.gstatic.com/generate_204')}`);
  lines.push('    interval: 300');
  lines.push('    tolerance: 50');
  addProxyList(nodeNames);

  lines.push(`  - name: ${yamlQuote('🔯 故障转移')}`);
  lines.push('    type: fallback');
  lines.push(`    url: ${yamlQuote('http://www.gstatic.com/generate_204')}`);
  lines.push('    interval: 180');
  addProxyList(nodeNames);

  lines.push(`  - name: ${yamlQuote('🔮 负载均衡')}`);
  lines.push('    type: load-balance');
  lines.push('    strategy: round-robin');
  lines.push(`    url: ${yamlQuote('http://www.gstatic.com/generate_204')}`);
  lines.push('    interval: 180');
  addProxyList(nodeNames);

  lines.push(`  - name: ${yamlQuote('🎯 全球直连')}`);
  lines.push('    type: select');
  addProxyList(['DIRECT', '🚀 节点选择', '♻️ 自动选择']);

  lines.push(`  - name: ${yamlQuote('🛑 全球拦截')}`);
  lines.push('    type: select');
  addProxyList(['REJECT', 'DIRECT']);

  lines.push(`  - name: ${yamlQuote('🐟 漏网之鱼')}`);
  lines.push('    type: select');
  addProxyList(['🚀 节点选择', '🎯 全球直连', '♻️ 自动选择', '🔯 故障转移', '🔮 负载均衡', ...nodeNames]);

  const aclBase = 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/';
  const providers = [
    ['LocalAreaNetwork', 'LocalAreaNetwork.list'],
    ['UnBan', 'UnBan.list'],
    ['BanAD', 'BanAD.list'],
    ['BanProgramAD', 'BanProgramAD.list'],
    ['GoogleCN', 'GoogleCN.list'],
    ['SteamCN', 'Ruleset/SteamCN.list'],
    ['Telegram', 'Telegram.list'],
    ['ProxyMedia', 'ProxyMedia.list'],
    ['ProxyLite', 'ProxyLite.list'],
    ['ChinaDomain', 'ChinaDomain.list'],
    ['ChinaCompanyIp', 'ChinaCompanyIp.list'],
  ];

  lines.push('rule-providers:');
  for (const [name, path] of providers) {
    lines.push(`  ${name}:`);
    lines.push('    type: http');
    lines.push('    behavior: classical');
    lines.push('    format: text');
    lines.push(`    url: ${yamlQuote(aclBase + path)}`);
    lines.push('    interval: 86400');
  }

  lines.push('rules:');
  lines.push('  - RULE-SET,LocalAreaNetwork,🎯 全球直连');
  lines.push('  - RULE-SET,UnBan,🎯 全球直连');
  lines.push('  - RULE-SET,BanAD,🛑 全球拦截');
  lines.push('  - RULE-SET,BanProgramAD,🛑 全球拦截');
  lines.push('  - RULE-SET,GoogleCN,🎯 全球直连');
  lines.push('  - RULE-SET,SteamCN,🎯 全球直连');
  lines.push('  - RULE-SET,Telegram,🚀 节点选择');
  lines.push('  - RULE-SET,ProxyMedia,🚀 节点选择');
  lines.push('  - RULE-SET,ProxyLite,🚀 节点选择');
  lines.push('  - RULE-SET,ChinaDomain,🎯 全球直连');
  lines.push('  - RULE-SET,ChinaCompanyIp,🎯 全球直连');
  lines.push('  - GEOIP,CN,🎯 全球直连');
  lines.push('  - MATCH,🐟 漏网之鱼');
  return lines.join('\n') + '\n';
}

function buildSingBoxJson(nodes) {
  const parsed = uniqueParsedNodes(nodes);
  const tags = parsed.map(p => p.name);
  const outbounds = parsed.map(p => {
    const out = {
      type: p.type,
      tag: p.name,
      server: p.server,
      server_port: p.port,
    };
    if (p.type === 'trojan') out.password = p.credential;
    else out.uuid = p.credential;
    if (p.type === 'vmess') {
      out.security = p.cipher || 'auto';
      out.alter_id = p.alterId || 0;
    }
    if (p.tls) {
      out.tls = { enabled: true, server_name: p.sni || p.server, insecure: false };
      if (p.fp) out.tls.utls = { enabled: true, fingerprint: p.fp === 'random' ? 'chrome' : p.fp };
    }
    if (p.network === 'ws' || p.network === 'xhttp') {
      out.transport = {
        type: 'ws',
        path: p.path || '/',
        headers: { Host: p.host || p.server },
      };
    }
    return out;
  });
  const config = {
    log: { level: 'info' },
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: tags.length ? tags : ['direct'] },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
    ],
    route: { final: 'proxy' },
  };
  return JSON.stringify(config, null, 2);
}

function buildLoonSubscription(nodes) {
  const parsed = uniqueParsedNodes(nodes);
  const lines = [];
  for (const p of parsed) {
    const name = String(p.name || '节点').replace(/,/g, '，');
    const common = [`${name} = ${p.type.toUpperCase()}`, p.server, String(p.port)];
    if (p.type === 'trojan') common.push(`password=${p.credential}`);
    else common.push(`uuid=${p.credential}`);
    if (p.type === 'vmess') common.push(`alterId=${p.alterId || 0}`, `cipher=${p.cipher || 'auto'}`);
    common.push('transport=ws');
    if (p.tls) common.push('over-tls=true', `tls-name=${p.sni || p.server}`);
    common.push(`ws-path=${p.path || '/'}`, `ws-headers=Host:${p.host || p.server}`);
    lines.push(common.join(','));
  }
  return lines.join('\n');
}

async function fetchOneSource(source, request) {
  const isp = normalizeIsp(new URL(request.url).searchParams.get('isp')) || detectIspFromCf(request.cf);
  const type = String(source.type || 'auto').toLowerCase();

  // code1 的“配置页/原始订阅”可能不是同一批节点。
  // 例如某些部署的 ?b64 只返回少量节点，但配置页中的 ADD/ADDAPI 仍有完整优选池。
  // 因此 code1 不再“遇到第一个非空结果就返回”，而是同时尝试直接订阅 + 配置页展开，最后合并去重。
  if (type === 'code1') {
    return fetchCode1Source(source, request, isp);
  }

  const candidates = buildCandidateUrls(source, isp);
  let lastError = '';
  for (const candidate of candidates) {
    const r = await fetchCandidateNodes(candidate.url);
    if (r.nodes.length) return { nodes: r.nodes, usedUrl: candidate.url, detectedType: candidate.kind, error: '' };
    lastError = r.error || lastError;
  }
  return { nodes: [], usedUrl: '', detectedType: source.type, error: lastError || '获取失败' };
}

async function fetchCode1Source(source, request, isp) {
  // V5.3：项目1自己负责 ADD / ADDAPI / ADDCSV 的完整展开。
  // 中控只消费项目1标准 Base64 订阅，不再使用 centralraw，也不读取/复制 ADDAPI。
  const candidates = buildCandidateUrls(source, isp);
  let best = { nodes: [], usedUrl: '', detectedType: 'code1', error: '' };
  const errors = [];

  for (const candidate of candidates) {
    const r = await fetchCandidateNodes(candidate.url);
    if (r.nodes.length > best.nodes.length) {
      best = { nodes: r.nodes, usedUrl: candidate.url, detectedType: candidate.kind, error: '' };
    }
    if (!r.nodes.length && r.error) errors.push(`${candidate.kind}: ${r.error}`);
  }

  return {
    nodes: best.nodes,
    usedUrl: best.usedUrl,
    detectedType: 'code1',
    error: best.nodes.length ? '' : (errors.join('；') || '项目1完整订阅获取失败'),
    warnings: errors,
    stats: { complete: best.nodes.length },
  };
}

async function fetchCandidateNodes(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(CONFIG.FETCH_TIMEOUT) || 6500);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'CF-Workers-SUB/Central-Hardcoded-Relay',
          'Accept': 'text/plain,*/*',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { nodes: [], error: `HTTP ${response.status}` };
    const content = (await response.text()).trim();
    if (!content) return { nodes: [], error: '返回内容为空' };
    const nodes = extractNodes(content);
    return { nodes, error: nodes.length ? '' : '返回成功，但未识别到节点' };
  } catch (error) {
    return { nodes: [], error: error?.name === 'AbortError' ? '请求超时' : String(error?.message || error) };
  }
}

function buildCandidateUrls(source, isp) {
  const list = [];
  const push = (url, kind) => {
    if (!url) return;
    if (!list.some(x => x.url === url)) list.push({ url, kind });
  };

  const type = String(source.type || 'auto').toLowerCase();
  if (type === 'code1') {
    push(toCode1Base64(source.url), 'code1-b64');
    push(source.url, 'generic-fallback');
  } else if (type === 'code2') {
    push(toCode2Base64(source.url, isp), 'code2');
    push(source.url, 'generic');
  } else {
    push(toCode1Base64(source.url), 'code1');
    push(toCode2Base64(source.url, isp), 'code2');
    push(source.url, 'generic');
  }
  return list;
}

function toCode1Base64(raw) {
  const u = new URL(raw);
  ['clash', 'singbox', 'sb', 'loon', 'base64', 'b64', 'centralraw'].forEach(k => u.searchParams.delete(k));
  u.searchParams.set('b64', '');
  return u.toString();
}

function toCode2Base64(raw, isp) {
  const u = new URL(raw);
  let path = u.pathname || '/';
  path = path.replace(/\/+$/, '');
  if (!path.toLowerCase().endsWith('/sub')) path += '/sub';
  u.pathname = path || '/sub';
  u.searchParams.set('target', 'base64');
  if (isp) u.searchParams.set('isp', isp);
  return u.toString();
}

function extractNodes(content) {
  const attempts = [String(content || '')];
  const decoded = tryDecodeBase64(content);
  if (decoded && decoded !== content) attempts.push(decoded);
  const out = [];
  const seen = new Set();

  for (const textValue of attempts) {
    const lines = String(textValue).replace(/\r/g, '\n').split(/\n+/).map(v => v.trim()).filter(Boolean);
    for (let line of lines) {
      line = line.replace(/^[-*]\s+/, '').trim();
      const lower = line.toLowerCase();
      if (!(lower.startsWith('vless://') || lower.startsWith('trojan://') || lower.startsWith('vmess://'))) continue;
      const key = canonicalNodeKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

async function rewriteNodeToCentral(node, source, centralHost, env = {}) {
  const lower = String(node || '').toLowerCase();
  if (lower.startsWith('vless://') || lower.startsWith('trojan://')) {
    return rewriteUriNode(node, source, centralHost, env);
  }
  if (lower.startsWith('vmess://')) {
    return rewriteVmessNode(node, source, centralHost, env);
  }
  return '';
}

async function rewriteUriNode(node, source, centralHost, env = {}) {
  let u;
  try { u = new URL(node); } catch { return ''; }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (!SUPPORTED_URI_SCHEMES.has(scheme)) return '';

  const transport = String(u.searchParams.get('type') || 'ws').toLowerCase();
  if (!SUPPORTED_TRANSPORTS.has(transport)) return '';

  const sourceUrl = new URL(source.url);
  // 保留源节点原始 server:port 作为 Relay 路由身份的一部分。
  // 同一 Worker 生成的多条优选节点通常只在 server 不同，Host/SNI/Path 完全相同；
  // 如果不把原始 server 写入签名 payload，重写后所有节点会得到相同 /relay/... 路径，
  // 随后被去重逻辑压成 1 条。
  const originalEndpoint = u.host;
  const originalHost = sanitizeHost(
    u.searchParams.get('host') || u.searchParams.get('sni') || sourceUrl.hostname,
  );
  if (!originalHost) return '';

  const originalPath = normalizeRelayOriginalPath(u.searchParams.get('path') || '/');
  const originalSecurity = String(u.searchParams.get('security') || '').toLowerCase();
  const upstreamScheme = originalSecurity === 'none' ? 'http' : 'https';

  const relayToken = await makeRelayToken({
    i: source._index,
    h: originalHost,
    p: originalPath,
    s: upstreamScheme,
    t: transport,
    a: originalEndpoint,
  }, env);

  // V6.17：源节点进入中控 Relay 时，客户端连接入口必须明确指向当前中控 Worker。
  // 旧版保留源节点原始 server:port，仅改 Host/SNI/Path；这要求原 server 恰好也是
  // 能承载 centralHost 的 Cloudflare 边缘入口，因此会出现“部分项目能用、部分项目无网络”。
  // 原始 server:port 已写入 relayToken 的 a 字段用于区分节点，所以这里改成 centralHost
  // 不会导致不同源节点被错误合并；ADD 仍会在 cloneAddNode() 中覆盖为用户指定优选入口。
  const relayPort = originalSecurity === 'none' ? '80' : '443';
  u.hostname = centralHost;
  u.port = relayPort;

  if (originalSecurity === 'none') {
    u.searchParams.set('security', 'none');
    u.searchParams.delete('sni');
  } else {
    u.searchParams.set('security', 'tls');
    u.searchParams.set('sni', centralHost);
  }
  u.searchParams.set('host', centralHost);
  u.searchParams.set('path', `/relay/${relayToken}`);
  u.searchParams.delete('ech');
  u.searchParams.delete('allowInsecure');
  return u.toString();
}

async function rewriteVmessNode(node, source, centralHost, env = {}) {
  const raw = String(node || '').slice('vmess://'.length);
  const decoded = tryDecodeBase64(raw);
  if (!decoded) return '';
  let obj;
  try { obj = JSON.parse(decoded); } catch { return ''; }

  const transport = String(obj.net || 'ws').toLowerCase();
  if (transport !== 'ws') return '';
  const sourceUrl = new URL(source.url);
  const originalHost = sanitizeHost(obj.host || obj.sni || sourceUrl.hostname);
  if (!originalHost) return '';
  const originalPath = normalizeRelayOriginalPath(obj.path || '/');
  const upstreamScheme = String(obj.tls || '').toLowerCase() === 'tls' ? 'https' : 'http';
  const originalEndpoint = `${obj.add || ''}:${obj.port || ''}`;
  const relayToken = await makeRelayToken({
    i: source._index,
    h: originalHost,
    p: originalPath,
    s: upstreamScheme,
    t: 'ws',
    a: originalEndpoint,
  }, env);

  // V6.17：VMess 与 VLESS/Trojan 一样，客户端必须先明确连接当前中控 Worker，
  // 再由 /relay/ 转发到源项目，不能继续保留源节点原始 add/port 作为客户端入口。
  const relayTls = String(obj.tls || '').toLowerCase() === 'tls';
  obj.add = centralHost;
  obj.port = relayTls ? '443' : '80';
  obj.host = centralHost;
  obj.sni = relayTls ? centralHost : '';
  obj.path = `/relay/${relayToken}`;
  if (obj.ech) delete obj.ech;
  return `vmess://${utf8ToBase64(JSON.stringify(obj))}`;
}

function normalizeRelayOriginalPath(value) {
  let p = String(value || '/').trim();
  try { p = decodeURIComponent(p); } catch {}
  if (!p.startsWith('/')) p = '/' + p;
  // 防止 //host 形式借 URL 解析覆盖目标主机。
  while (p.startsWith('//')) p = p.slice(1);
  return p || '/';
}

function sanitizeHost(value) {
  let host = String(value || '').trim();
  host = host.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').trim();
  if (host.includes(':') && !host.startsWith('[')) {
    const last = host.lastIndexOf(':');
    if (/^\d+$/.test(host.slice(last + 1))) host = host.slice(0, last);
  }
  if (!host || /[\s\\]/.test(host)) return '';
  return host;
}

async function handleRelay(request, currentUrl, env = {}) {
  const expiry = getExpiryState(env.EXPIRY_DATE);
  if (!expiry.valid) return text(expiry.message, 403, { 'Cache-Control': 'no-store' });
  const prefix = '/relay/';
  const token = currentUrl.pathname.startsWith(prefix) ? currentUrl.pathname.slice(prefix.length) : '';
  if (!token) return text('Relay token missing', 404);

  const payload = await verifyRelayToken(token, env);
  if (!payload) return text('Invalid relay token', 403);

  const sourceIndex = Number(payload.i);
  const source = CONFIG.SOURCES[sourceIndex];
  if (!source || source.enabled === false || !String(source.url || '').trim()) {
    return text('Relay source disabled', 410);
  }

  const upstreamHost = sanitizeHost(payload.h);
  if (!upstreamHost) return text('Invalid relay host', 400);
  const scheme = payload.s === 'http' ? 'http' : 'https';
  const transport = String(payload.t || 'ws').toLowerCase();
  let originalPath = normalizeRelayOriginalPath(payload.p || '/');

  // XHTTP / 某些实现会在实际请求时附加动态查询参数；合并进去继续转发。
  if (currentUrl.search) {
    const base = new URL(`${scheme}://${upstreamHost}${originalPath}`);
    const runtimeParams = currentUrl.searchParams;
    for (const [k, v] of runtimeParams.entries()) base.searchParams.append(k, v);
    originalPath = base.pathname + base.search;
  }

  const upstreamUrl = `${scheme}://${upstreamHost}${originalPath}`;

  // V5.8：WS 不再只返回一次 fetch() 的 Upgrade Response，而是在中控显式建立两端 WebSocket 并双向桥接。
  // 这样中控既是真正的数据通道，又能在每次连接时执行 UUID 签名与 EXPIRY_DATE 校验。
  if (transport === 'ws') {
    if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return text('Expected Upgrade: websocket', 426, { 'Cache-Control': 'no-store' });
    }

    const upstreamHeaders = new Headers();
    upstreamHeaders.set('Upgrade', 'websocket');
    const earlyData = request.headers.get('Sec-WebSocket-Protocol');
    if (earlyData) upstreamHeaders.set('Sec-WebSocket-Protocol', earlyData);
    const userAgent = request.headers.get('User-Agent');
    if (userAgent) upstreamHeaders.set('User-Agent', userAgent);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'GET',
        headers: upstreamHeaders,
        redirect: 'manual',
      });
    } catch (error) {
      return text(`Relay WebSocket upstream connect failed: ${error?.message || error}`, 502, { 'Cache-Control': 'no-store' });
    }

    const upstreamSocket = upstreamResponse && upstreamResponse.webSocket;
    if (!upstreamSocket) {
      return text(`Relay WebSocket upstream rejected: HTTP ${upstreamResponse?.status || 502}`, 502, { 'Cache-Control': 'no-store' });
    }

    // Cloudflare 在兼容日期 >= 2026-03-17 时，二进制 WebSocket 消息默认以 Blob 交付。
    // Worker WebSocket.send() 只接受 string / ArrayBuffer / ArrayBufferView，
    // 因此必须在 accept() 之前固定为 arraybuffer，否则 VLESS/Trojan 二进制帧会在 Relay 中断。
    upstreamSocket.binaryType = 'arraybuffer';
    try {
      upstreamSocket.accept({ allowHalfOpen: true });
    } catch {
      upstreamSocket.accept();
    }

    const pair = new WebSocketPair();
    const [clientSocket, centralSocket] = Object.values(pair);
    centralSocket.binaryType = 'arraybuffer';
    try {
      centralSocket.accept({ allowHalfOpen: true });
    } catch {
      centralSocket.accept();
    }
    bridgeWebSockets(centralSocket, upstreamSocket);

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }

  // XHTTP 保持 HTTP/流式转发，不走 WebSocketPair。
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.delete('cdn-loop');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-proto');
  headers.delete('content-length');
  headers.delete('upgrade');
  headers.delete('connection');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  return fetch(new Request(upstreamUrl, init));
}

function bridgeWebSockets(left, right) {
  let closing = false;

  const closeBoth = (code = 1000, reason = '') => {
    if (closing) return;
    closing = true;
    try { left.close(code, reason); } catch { try { left.close(); } catch {} }
    try { right.close(code, reason); } catch { try { right.close(); } catch {} }
  };

  left.addEventListener('message', event => {
    try { right.send(event.data); }
    catch { closeBoth(1011, 'relay client->upstream failed'); }
  });

  right.addEventListener('message', event => {
    try { left.send(event.data); }
    catch { closeBoth(1011, 'relay upstream->client failed'); }
  });

  left.addEventListener('close', event => closeBoth(event?.code || 1000, event?.reason || ''));
  right.addEventListener('close', event => closeBoth(event?.code || 1000, event?.reason || ''));
  left.addEventListener('error', () => closeBoth(1011, 'relay client error'));
  right.addEventListener('error', () => closeBoth(1011, 'relay upstream error'));
}

// Relay 签名密钥固定使用环境变量 UUID。
// 因此无需再配置 RELAY_SECRET；修改 UUID 后旧 Relay 节点会立即失效。
function getRelaySecret(env = {}) {
  return String(env.UUID || env.uuid || '').trim();
}

async function makeRelayToken(payload, env = {}) {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacBytes(getRelaySecret(env), body);
  return `${body}.${base64UrlEncode(sig)}`;
}

async function verifyRelayToken(token, env = {}) {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expectedBytes = await hmacBytes(getRelaySecret(env), body);
  const expected = base64UrlEncode(expectedBytes);
  if (!safeEqual(sig, expected)) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(body));
    const payload = JSON.parse(decoded);
    if (!Number.isInteger(Number(payload.i))) return null;
    if (!payload.h || !payload.p) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function hmacBytes(secret, data) {
  if (!secret) throw new Error('请先设置 Cloudflare 环境变量 UUID');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function base64UrlEncode(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  let b64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function canonicalNodeKey(node) {
  const value = String(node || '').trim();
  if (!value) return '';
  const hash = value.indexOf('#');
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

function tryDecodeBase64(input) {
  let value = String(input || '').trim().replace(/\s+/g, '');
  if (!value) return '';
  value = value.replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return ''; }
}

function utf8ToBase64(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalizeIsp(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['mobile', 'cmcc', '移动'].includes(v)) return 'mobile';
  if (['unicom', 'cucc', '联通'].includes(v)) return 'unicom';
  if (['telecom', 'ctcc', '电信'].includes(v)) return 'telecom';
  return '';
}

function detectIspFromCf(cf = {}) {
  const asn = Number(cf?.asn || 0);
  const org = String(cf?.asOrganization || cf?.organization || '').toLowerCase();
  if (/china\s*mobile|cmcc|中国移动|移动/.test(org)) return 'mobile';
  if (/china\s*unicom|cucc|中国联通|联通/.test(org)) return 'unicom';
  if (/china\s*telecom|chinanet|ctcc|中国电信|电信/.test(org)) return 'telecom';
  const mobile = new Set([9808, 24400, 56040, 56041, 56046, 56048]);
  const unicom = new Set([4837, 9929, 10099, 17621, 4808]);
  const telecom = new Set([4134, 4809, 4812, 23724, 58563]);
  if (mobile.has(asn)) return 'mobile';
  if (unicom.has(asn)) return 'unicom';
  if (telecom.has(asn)) return 'telecom';
  return '';
}


async function handleDiagnose(request, env = {}) {
  const url = new URL(request.url);
  const accessKey = String(env.UUID || env.uuid || '').trim();
  const expiry = getExpiryState(env.EXPIRY_DATE);
  const startedAt = Date.now();

  const results = [];
  for (let index = 0; index < CONFIG.SOURCES.length; index++) {
    results.push(await probeSourceWebSocket(CONFIG.SOURCES[index], index, request));
  }

  const report = {
    ok: results.some(x => x.dataChannelOk === true || x.wsHandshake === true),
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    compatibilityDateNote: '兼容日期 2026-01-20 无需因为 Blob 行为改动而调整。',
    workerToWorkerHint: '如果 WS 探测出现 1042、目标 Worker 未命中或 response.webSocket=false，而源项目使用 Workers Route/workers.dev，请在中控 Worker 增加 compatibility flag: global_fetch_strictly_public。',
    subscriptionPath: `/${accessKey}`,
    expiry,
    sources: results,
  };

  if (url.searchParams.has('json')) return json(report);
  return new Response(renderDiagnoseHtml(report), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}

async function probeSourceWebSocket(source, index, request) {
  const raw = String(source?.url || '').trim();
  const base = {
    index,
    name: source?.name || `项目${index + 1}`,
    configured: !!raw,
    enabled: source?.enabled !== false,
    host: safeSourceDisplayHost(raw),
    subscriptionOk: false,
    nodeCount: 0,
    wsCandidateFound: false,
    wsHandshake: false,
    wsHttpStatus: null,
    wsResponseHasSocket: false,
    targetHost: '',
    targetPath: '',
    dataProbeAttempted: false,
    dataChannelOk: false,
    dataProbeBytes: 0,
    dataProbeError: '',
    elapsedMs: 0,
    error: '',
    hint: '',
  };

  if (!raw) {
    base.error = '未填写源 URL';
    return base;
  }
  if (source?.enabled === false) {
    base.error = '源项目已停用';
    return base;
  }

  const startedAt = Date.now();
  const normalized = { ...source, _index: index };
  let fetched;
  try {
    fetched = await fetchOneSource(normalized, request);
  } catch (error) {
    base.error = `订阅读取异常：${error?.message || error}`;
    base.elapsedMs = Date.now() - startedAt;
    return base;
  }

  base.nodeCount = Array.isArray(fetched?.nodes) ? fetched.nodes.length : 0;
  base.subscriptionOk = base.nodeCount > 0;
  if (!base.subscriptionOk) {
    base.error = fetched?.error || '订阅读取成功，但没有识别到节点';
    base.elapsedMs = Date.now() - startedAt;
    return base;
  }

  let target = null;
  for (const node of fetched.nodes) {
    target = getWsProbeTarget(node, normalized);
    if (target) break;
  }

  if (!target) {
    base.error = '订阅有节点，但没有找到可测试的 WS 节点';
    base.hint = '当前诊断只主动测试 WS；XHTTP 节点不会在这里做 101 握手。';
    base.elapsedMs = Date.now() - startedAt;
    return base;
  }

  base.wsCandidateFound = true;
  base.targetHost = target.host;
  base.targetPath = target.path;

  const probe = await probeUpstreamWebSocket(target, request);
  base.wsHandshake = probe.handshakeOk;
  base.wsHttpStatus = probe.status;
  base.wsResponseHasSocket = probe.hasWebSocket;
  base.dataProbeAttempted = probe.dataProbeAttempted === true;
  base.dataChannelOk = probe.dataChannelOk === true;
  base.dataProbeBytes = Number(probe.dataProbeBytes || 0);
  base.dataProbeError = probe.dataProbeError || '';
  base.error = probe.error || '';
  base.hint = classifyWorkerFetchIssue(probe);
  base.elapsedMs = Date.now() - startedAt;
  return base;
}

function getWsProbeTarget(node, source) {
  const value = String(node || '').trim();
  const lower = value.toLowerCase();
  const sourceUrl = (() => { try { return new URL(source.url); } catch { return null; } })();
  if (!sourceUrl) return null;

  if (lower.startsWith('vless://') || lower.startsWith('trojan://')) {
    let u;
    try { u = new URL(value); } catch { return null; }
    const transport = String(u.searchParams.get('type') || 'ws').toLowerCase();
    if (transport !== 'ws') return null;
    const host = sanitizeHost(u.searchParams.get('host') || u.searchParams.get('sni') || sourceUrl.hostname);
    if (!host) return null;
    const path = normalizeRelayOriginalPath(u.searchParams.get('path') || '/');
    const security = String(u.searchParams.get('security') || '').toLowerCase();
    const scheme = security === 'none' ? 'http' : 'https';
    const protocol = lower.startsWith('vless://') ? 'vless' : 'trojan';
    const credential = decodeURIComponent(u.username || '');
    return { url: `${scheme}://${host}${path}`, host, path, scheme, protocol, credential };
  }

  if (lower.startsWith('vmess://')) {
    const decoded = tryDecodeBase64(value.slice(8));
    if (!decoded) return null;
    let obj;
    try { obj = JSON.parse(decoded); } catch { return null; }
    if (String(obj.net || 'ws').toLowerCase() !== 'ws') return null;
    const host = sanitizeHost(obj.host || obj.sni || sourceUrl.hostname);
    if (!host) return null;
    const path = normalizeRelayOriginalPath(obj.path || '/');
    const scheme = String(obj.tls || '').toLowerCase() === 'tls' ? 'https' : 'http';
    return { url: `${scheme}://${host}${path}`, host, path, scheme, protocol: 'vmess', credential: String(obj.id || '') };
  }

  return null;
}

async function probeUpstreamWebSocket(target, request) {
  const upstreamUrl = String(target?.url || target || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(CONFIG.FETCH_TIMEOUT) || 12000, 12000));
  try {
    const headers = new Headers();
    headers.set('Upgrade', 'websocket');
    const ua = request.headers.get('User-Agent');
    if (ua) headers.set('User-Agent', ua);

    const response = await fetch(upstreamUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    const ws = response?.webSocket || null;
    const result = {
      ok: !!ws,
      handshakeOk: !!ws,
      status: Number(response?.status || 0),
      hasWebSocket: !!ws,
      dataProbeAttempted: false,
      dataChannelOk: false,
      dataProbeBytes: 0,
      dataProbeError: '',
      error: ws ? '' : `上游没有返回 WebSocket（HTTP ${response?.status || 0}）`,
    };

    if (ws) {
      try {
        ws.binaryType = 'arraybuffer';
        try { ws.accept({ allowHalfOpen: true }); } catch { ws.accept(); }

        // V6.1：对 VLESS 源做一次真实首包探测。握手 101 只能证明 WS 打开；
        // 这里实际发送 VLESS TCP 请求并等待源 Worker 返回第一段数据，确认源节点的数据层能工作。
        if (target?.protocol === 'vless' && isUuidLike(target?.credential)) {
          result.dataProbeAttempted = true;
          const dataProbe = await probeVlessDataChannel(ws, target.credential);
          result.dataChannelOk = dataProbe.ok;
          result.dataProbeBytes = dataProbe.bytes;
          result.dataProbeError = dataProbe.error || '';
        }

        try { ws.close(1000, 'diagnose'); } catch { try { ws.close(); } catch {} }
      } catch (error) {
        result.ok = false;
        result.handshakeOk = false;
        result.error = `上游 WebSocket 对象存在，但 accept/数据探测异常：${error?.message || error}`;
      }
    }
    return result;
  } catch (error) {
    const msg = error?.name === 'AbortError' ? 'WebSocket 探测超时' : String(error?.message || error);
    return { ok: false, handshakeOk: false, status: 0, hasWebSocket: false, dataProbeAttempted: false, dataChannelOk: false, dataProbeBytes: 0, dataProbeError: '', error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function uuidToBytes(uuid) {
  const hex = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buildVlessTcpProbePacket(uuid, host = 'example.com', port = 80) {
  const id = uuidToBytes(uuid);
  if (!id) return null;
  const hostBytes = new TextEncoder().encode(host);
  if (!hostBytes.length || hostBytes.length > 255) return null;
  const requestText = `HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
  const payload = new TextEncoder().encode(requestText);
  const header = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 1 + hostBytes.length);
  let p = 0;
  header[p++] = 0; // VLESS version
  header.set(id, p); p += 16;
  header[p++] = 0; // addons length
  header[p++] = 1; // TCP
  header[p++] = (port >> 8) & 0xff;
  header[p++] = port & 0xff;
  header[p++] = 2; // domain
  header[p++] = hostBytes.length;
  header.set(hostBytes, p);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

async function probeVlessDataChannel(ws, uuid) {
  const packet = buildVlessTcpProbePacket(uuid);
  if (!packet) return { ok: false, bytes: 0, error: '无法构造 VLESS 探测首包' };

  return await new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, bytes: 0, error: 'VLESS 数据探测超时：WS 已握手，但 5 秒内没有收到源 Worker 返回数据' }), 5000);

    ws.addEventListener('message', event => {
      let bytes = 0;
      const data = event?.data;
      if (data instanceof ArrayBuffer) bytes = data.byteLength;
      else if (ArrayBuffer.isView(data)) bytes = data.byteLength;
      else if (typeof data === 'string') bytes = new TextEncoder().encode(data).byteLength;
      else if (data && typeof data.size === 'number') bytes = Number(data.size || 0);
      finish(bytes > 0
        ? { ok: true, bytes, error: '' }
        : { ok: false, bytes: 0, error: '源 Worker 返回了空数据帧' });
    });
    ws.addEventListener('error', () => finish({ ok: false, bytes: 0, error: 'VLESS 数据探测期间 WebSocket 报错' }));
    ws.addEventListener('close', () => finish({ ok: false, bytes: 0, error: 'VLESS 数据探测期间 WebSocket 提前关闭' }));

    try {
      ws.send(packet);
    } catch (error) {
      finish({ ok: false, bytes: 0, error: `发送 VLESS 探测首包失败：${error?.message || error}` });
    }
  });
}

function classifyWorkerFetchIssue(probe) {
  const textValue = String(probe?.error || '');
  if (/1042/i.test(textValue)) {
    return '检测到 Cloudflare 1042。中控到源 Worker 的全局 fetch 被阻止；请在中控 Worker 增加 compatibility flag：global_fetch_strictly_public。';
  }
  if (probe?.hasWebSocket && probe?.dataProbeAttempted && probe?.dataChannelOk) {
    return '源项目 WS 握手和 VLESS 真实数据探测均成功。若客户端仍无网络，应重点检查中控入口/Relay，而不是源项目。';
  }
  if (probe?.hasWebSocket && probe?.dataProbeAttempted && !probe?.dataChannelOk) {
    return `源项目 WS 握手成功，但真实 VLESS 数据探测失败：${probe.dataProbeError || '未收到数据'}。`;
  }
  if (probe?.hasWebSocket) {
    return '源项目 WebSocket 握手成功；当前候选不是可直接探测的 VLESS 节点，因此没有执行真实数据首包测试。';
  }
  if (Number(probe?.status || 0) >= 300 && Number(probe?.status || 0) < 400) {
    return '上游发生重定向。WebSocket Relay 不能依赖普通网页跳转，请检查源节点 Host/Path 是否直接命中源 Worker。';
  }
  if (Number(probe?.status || 0) === 404) {
    return '上游返回 404，说明当前节点里的 Host/Path 没有命中对应源 Worker 路由。';
  }
  if (!probe?.hasWebSocket) {
    return '订阅能读取，但 Worker-to-Worker WebSocket 握手失败。若源项目使用 Workers Route/workers.dev，可尝试在中控 Worker 增加 global_fetch_strictly_public；若使用 Custom Domain，则重点检查节点 Host/Path。';
  }
  return '';
}

function renderDiagnoseHtml(report) {
  const rows = (report.sources || []).map(s => {
    const subClass = s.subscriptionOk ? 'ok' : 'bad';
    const wsClass = s.wsHandshake ? 'ok' : 'bad';
    return `<div class="diag-card">
      <h2>${escapeHtml(s.name)}</h2>
      <div class="diag-row"><span>源域名</span><b>${escapeHtml(s.host || '未配置')}</b></div>
      <div class="diag-row"><span>订阅读取</span><b class="${subClass}">${s.subscriptionOk ? `成功 · ${s.nodeCount} 节点` : '失败'}</b></div>
      <div class="diag-row"><span>WS 候选</span><b>${s.wsCandidateFound ? '已找到' : '未找到'}</b></div>
      <div class="diag-row"><span>WS 握手</span><b class="${wsClass}">${s.wsHandshake ? '成功' : '失败'}</b></div>
      <div class="diag-row"><span>HTTP 状态</span><b>${escapeHtml(s.wsHttpStatus ?? '-')}</b></div>
      <div class="diag-row"><span>response.webSocket</span><b>${s.wsResponseHasSocket ? 'true' : 'false'}</b></div>
      <div class="diag-row"><span>真实数据探测</span><b class="${s.dataProbeAttempted ? (s.dataChannelOk ? 'ok' : 'bad') : ''}">${s.dataProbeAttempted ? (s.dataChannelOk ? `成功 · ${s.dataProbeBytes} bytes` : '失败') : '未执行'}</b></div>
      <div class="diag-row"><span>目标 Host</span><b>${escapeHtml(s.targetHost || '-')}</b></div>
      <div class="diag-row"><span>目标 Path</span><b class="mono">${escapeHtml(s.targetPath || '-')}</b></div>
      ${s.error ? `<div class="diag-msg badbox">${escapeHtml(s.error)}</div>` : ''}
      ${s.dataProbeError ? `<div class="diag-msg badbox">${escapeHtml(s.dataProbeError)}</div>` : ''}
      ${s.hint ? `<div class="diag-msg hint">${escapeHtml(s.hint)}</div>` : ''}
    </div>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>中控连接诊断</title>
  <style>body{margin:0;background:#f4f7f9;color:#222;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}.wrap{max-width:980px;margin:auto;padding:22px}.top,.diag-card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,.06)}.top{padding:20px;margin-bottom:18px}.top h1{font-size:24px;margin:0 0 8px}.top p{margin:5px 0;color:#667085}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.diag-card{padding:18px}.diag-card h2{font-size:18px;margin:0 0 12px}.diag-row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #eef2f6}.diag-row span{color:#667085}.diag-row b{text-align:right;word-break:break-all}.ok{color:#067647}.bad{color:#b42318}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.diag-msg{margin-top:12px;padding:11px;border-radius:10px;white-space:pre-wrap;word-break:break-word}.badbox{background:#fef3f2;color:#b42318}.hint{background:#eff8ff;color:#175cd3}.flag{margin-top:12px;background:#fff7ed;color:#9a3412;padding:12px;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}@media(max-width:760px){.grid{grid-template-columns:1fr}.wrap{padding:12px}.diag-row{flex-direction:column;gap:2px}.diag-row b{text-align:left}}</style></head><body><div class="wrap">
  <div class="top"><h1>中控连接诊断</h1><p>${escapeHtml(report.compatibilityDateNote)}</p><p>这个页面会从中控 Worker 发起源订阅读取、WebSocket 握手，并对 VLESS 候选发送真实首包，区分“只握手成功”和“实际数据可通”。</p><div class="flag">${escapeHtml(report.workerToWorkerHint)}</div></div>
  <div class="grid">${rows || '<div class="diag-card">没有配置源项目</div>'}</div>
  </div></body></html>`;
}

async function handleStatus(request, env = {}) {
  const sources = configuredSources();
  const results = await Promise.all(CONFIG.SOURCES.map(async (source, index) => {
    const raw = String(source?.url || '').trim();
    if (!raw || source?.enabled === false) {
      return { index, name: source?.name || `项目${index + 1}`, configured: !!raw, enabled: source?.enabled !== false, ok: false, count: 0, error: raw ? '已停用' : '未填写 URL' };
    }
    const normalized = { ...source, _index: index };
    const r = await fetchOneSource(normalized, request);
    let relayCount = 0;
    for (const n of r.nodes) {
      if (await canRewriteNode(n)) relayCount++;
    }
    return {
      index,
      name: source.name || `项目${index + 1}`,
      configured: true,
      enabled: true,
      ok: relayCount > 0,
      count: r.nodes.length,
      relayCount,
      host: safeSourceDisplayHost(raw),
      stats: r.stats || null,
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
      error: relayCount > 0 ? '' : (r.error || '没有可中控转发的节点'),
    };
  }));
  return json({ ok: true, subscriptionPath: `/${String(env.UUID || env.uuid || '').trim()}`, sources: results, configuredCount: sources.length, addCount: parseAddEntries(env.ADD).length, expiry: getExpiryState(env.EXPIRY_DATE) });
}

async function canRewriteNode(node) {
  const lower = String(node || '').toLowerCase();
  if (lower.startsWith('vless://') || lower.startsWith('trojan://')) {
    try {
      const u = new URL(node);
      return SUPPORTED_TRANSPORTS.has(String(u.searchParams.get('type') || 'ws').toLowerCase());
    } catch { return false; }
  }
  if (lower.startsWith('vmess://')) {
    const decoded = tryDecodeBase64(String(node).slice(8));
    if (!decoded) return false;
    try { return String(JSON.parse(decoded).net || 'ws').toLowerCase() === 'ws'; } catch { return false; }
  }
  return false;
}

function safeSourceDisplayHost(raw) {
  try { return new URL(raw).hostname; } catch { return ''; }
}

function hasSubscriptionQuery(url) {
  const keys = ['sub', 'b64', 'base64', 'raw', 'plain', 'target', 'clash', 'singbox', 'sb', 'loon'];
  return keys.some(k => url.searchParams.has(k));
}

function getExpiryState(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return {
      valid: true,
      configured: false,
      value: '',
      daysLeft: null,
      expireTimestamp: 4102329600,
      message: '未设置到期时间',
    };
  }

  const beijingDate = new Date(`${raw}T00:00:00+08:00`);
  if (Number.isNaN(beijingDate.getTime())) {
    return {
      valid: true,
      configured: true,
      value: raw,
      daysLeft: null,
      expireTimestamp: 4102329600,
      message: 'EXPIRY_DATE 格式无效，请使用 YYYY-MM-DD',
      invalidFormat: true,
    };
  }

  // 与项目1一致：填写日期当天仍可使用，次日 00:00:00（北京时间）失效。
  const expiryTime = beijingDate.getTime() + 24 * 60 * 60 * 1000;
  const now = Date.now();
  const expireTimestamp = Math.floor(expiryTime / 1000);
  if (now >= expiryTime) {
    return {
      valid: false,
      configured: true,
      value: raw,
      daysLeft: 0,
      expireTimestamp,
      message: `❌ 订阅已过期！\n有效期至：${raw}\n请联系管理员。`,
    };
  }

  return {
    valid: true,
    configured: true,
    value: raw,
    daysLeft: Math.ceil((expiryTime - now) / (24 * 60 * 60 * 1000)),
    expireTimestamp,
    message: '订阅有效',
  };
}

const HTTP_PORTS = new Set(['80', '8080', '8880', '2052', '2082', '2086', '2095']);

function parseAddEntries(value) {
  const input = String(value || '').trim();
  if (!input) return [];
  // 支持 CF 变量里常见的：换行、英文/中文逗号、英文/中文分号、Tab 分隔。
  const parts = input
    .replace(/[\t"'\r\n,，;；]+/g, ',')
    .replace(/,+/g, ',')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const item of parts) {
    const entry = parseAddEntry(item);
    if (!entry) continue;
    // 相同 server/port 但备注不同属于用户明确配置的不同 ADD，必须保留。
    const key = `${entry.host.toLowerCase()}|${entry.port}|${entry.remark}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function parseAddEntry(item) {
  let raw = String(item || '').trim();
  if (!raw) return null;
  let remark = '';
  const hash = raw.indexOf('#');
  if (hash >= 0) {
    remark = raw.slice(hash + 1).trim();
    raw = raw.slice(0, hash).trim();
  }
  if (!raw) return null;

  let host = raw;
  let port = '443';
  if (raw.startsWith('[')) {
    const m = raw.match(/^(\[[^\]]+\])(?::(\d+))?$/);
    if (!m) return null;
    host = m[1];
    port = m[2] || '443';
  } else {
    const last = raw.lastIndexOf(':');
    if (last > 0 && /^\d+$/.test(raw.slice(last + 1))) {
      host = raw.slice(0, last).trim();
      port = raw.slice(last + 1);
    }
  }
  if (!host || !/^\d+$/.test(port)) return null;
  const n = Number(port);
  if (n < 1 || n > 65535) return null;
  return { host, port: String(n), remark: remark || host };
}

function isUriRelayNode(node) {
  const lower = String(node || '').toLowerCase();
  return lower.startsWith('vless://') || lower.startsWith('trojan://');
}

function cloneAddNode(template, entry, centralHost) {
  try {
    const u = new URL(template);
    if (!isUriRelayNode(template)) return '';
    u.hostname = entry.host;
    u.port = entry.port;
    // V6.3：避免 ADD 地址在 URL 重写后被截断或异常归一化。
    const expectedHost = String(entry.host || '').replace(/^\[|\]$/g, '').toLowerCase();
    const actualHost = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!actualHost || actualHost !== expectedHost || String(u.port || '') !== String(entry.port || '')) return '';
    const isHttp = HTTP_PORTS.has(entry.port);
    u.searchParams.set('security', isHttp ? 'none' : 'tls');
    u.searchParams.set('host', centralHost);
    if (isHttp) u.searchParams.delete('sni');
    else u.searchParams.set('sni', centralHost);
    u.hash = entry.remark;
    return u.toString();
  } catch {
    return '';
  }
}

function h5Page(request, env, expiry) {
  const url = new URL(request.url);
  const accessKey = String(env.UUID || env.uuid || '').trim();
  const baseUrl = `${url.protocol}//${url.host}/${encodeURIComponent(accessKey)}`;
  const primaryUrl = baseUrl;
  const b64Url = `${baseUrl}?b64`;
  const clashUrl = `${baseUrl}?clash`;
  const singboxUrl = `${baseUrl}?sb`;
  const loonUrl = `${baseUrl}?loon`;
  const rawUrl = `${baseUrl}?raw`;
  const addEntries = parseAddEntries(env.ADD);
  const addDisplay = addEntries.length
    ? addEntries.map(x => `${escapeHtml(x.host)}:${escapeHtml(x.port)}${x.remark ? `#${escapeHtml(x.remark)}` : ''}`).join('<br>')
    : '未设置';
  const expiryText = expiry.configured
    ? (expiry.invalidFormat ? escapeHtml(expiry.message) : `${escapeHtml(expiry.value)}${expiry.daysLeft != null ? `（剩余 ${expiry.daysLeft} 天）` : ''}`)
    : '未设置（长期有效）';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>配置中心</title>
  <style>${h5Css()}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀配置中心</h1>

      <!-- 与项目1 H5 对接：动态加载软件下载 / 使用教程 -->
      <div class="client-links-panel" id="clientLinksPanel">
        <div class="client-links-title">软件下载 / 使用教程</div>
        <div class="client-links-grid" id="clientLinksGrid">
          <div class="client-links-loading">正在加载下载按钮...</div>
        </div>
      </div>
    </div>

    <section class="card wide">
      <h2 class="card-title">订阅链接 <span class="expiry-inline">有效期至：${expiryText}</span></h2>
      <div class="subscription-grid">
        ${subscriptionCard('小火煎订阅', primaryUrl, true)}
        ${subscriptionCard('Base64订阅', b64Url, false)}
        ${subscriptionCard('Clash订阅', clashUrl, false)}
        ${subscriptionCard('SingBox订阅', singboxUrl, false)}
        ${subscriptionCard('Loon订阅', loonUrl, false)}
        ${subscriptionCard('Raw订阅', rawUrl, false)}
      </div>
    </section>

  </div>

  <div class="toast" id="toast"></div>
  <div class="modal" id="qrModal" onclick="if(event.target===this)closeQR()">
    <div class="modal-box">
      <button class="close" type="button" id="qrClose">×</button>
      <h3 id="qrTitle">订阅二维码</h3>
      <div id="qrBox"></div>
      <div class="qr-url" id="qrUrl"></div>
    </div>
  </div>

<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
<script>
const STATUS_URL=${JSON.stringify(`${baseUrl}/status.json`)};
const CLIENT_LINKS_API='https://dh.junkamf.com/api/client-links';

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>el.classList.remove('show'),2200)}

async function copyText(value){
  const v=String(value||'');
  try{
    if(navigator.clipboard&&window.isSecureContext){
      await navigator.clipboard.writeText(v);
    }else{
      const t=document.createElement('textarea');
      t.value=v;t.setAttribute('readonly','');t.style.position='fixed';t.style.opacity='0';
      document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();
    }
    toast('✅ 已复制到剪贴板');
  }catch(e){toast('❌ 复制失败，请长按订阅地址复制')}
}

function openShadowrocket(value){
  const v=String(value||'');
  if(!/iPad|iPhone|iPod/i.test(navigator.userAgent)){
    toast('⚠️ 该功能仅支持 iOS 设备上的 Shadowrocket');
    return;
  }
  window.location.href='shadowrocket://add?url='+encodeURIComponent(v);
}

function showQR(value,title){
  const modal=document.getElementById('qrModal');
  const qrBox=document.getElementById('qrBox');
  document.getElementById('qrTitle').textContent=String(title||'订阅')+' - 二维码';
  document.getElementById('qrUrl').textContent=String(value||'');
  qrBox.innerHTML='';
  modal.classList.add('show');
  try{
    if(typeof QRCode==='function'){
      new QRCode(qrBox,{text:String(value||''),width:220,height:220,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
    }else if(window.QRCode&&QRCode.toCanvas){
      const canvas=document.createElement('canvas');qrBox.appendChild(canvas);QRCode.toCanvas(canvas,String(value||''),{width:220,margin:1},()=>{});
    }else{
      qrBox.textContent='二维码组件加载失败，请复制订阅地址。';
    }
  }catch(e){qrBox.textContent='二维码生成失败，请复制订阅地址。'}
}
function closeQR(){document.getElementById('qrModal').classList.remove('show')}
document.getElementById('qrClose').addEventListener('click',closeQR);

async function loadClientLinks(){
  const grid=document.getElementById('clientLinksGrid');
  if(!grid)return;
  try{
    const response=await fetch(CLIENT_LINKS_API+'?t='+Date.now(),{method:'GET',cache:'no-store'});
    if(!response.ok)throw new Error('HTTP '+response.status);
    const data=await response.json();
    renderClientLinks(data&&data.links?data.links:{});
  }catch(error){
    console.error('加载下载按钮失败:',error);
    renderClientLinks({});
  }
}

function renderClientLinks(links){
  const grid=document.getElementById('clientLinksGrid');
  if(!grid)return;
  const items=[
    {key:'shadowrocketDownload',label:'🚀 小火箭下载',type:'download'},
    {key:'androidDownload',label:'🤖 安卓下载包',type:'download'},
    {key:'windowsDownload',label:'💻 WIN安装包',type:'download'},
    {key:'macDownload',label:'🖥️ Mac安装包',type:'download'},
    {key:'appleTutorial',label:'🍎 小火煎使用教程',type:'tutorial'},
    {key:'androidTutorial',label:'📘 安卓使用教程',type:'tutorial'},
    {key:'windowsTutorial',label:'📘 电脑使用教程',type:'tutorial'},
    {key:'macTutorial',label:'📘 Mac使用教程',type:'tutorial'}
  ];
  grid.innerHTML='';
  let count=0;
  items.forEach(item=>{
    const href=String((links&&links[item.key])||'').trim();
    if(!href)return;
    const a=document.createElement('a');
    a.className='client-link-btn'+(item.type==='download'?' download':'');
    a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.textContent=item.label;
    grid.appendChild(a);count++;
  });
  if(!count){
    const empty=document.createElement('div');empty.className='client-links-empty';empty.textContent='下载/教程按钮还没有配置，请联系管理员';grid.appendChild(empty);
  }
}

async function loadStatus(){
  const el=document.getElementById('sources');
  try{
    const r=await fetch(STATUS_URL+'?t='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    el.innerHTML=(d.sources||[]).map(s=>'<div class="source-row"><div><b>'+esc(s.name)+'</b><div class="source-host">'+esc(s.host||'未填写 URL')+'</div></div><div class="source-badge '+(s.ok?'ok':'bad')+'">'+(s.ok?('可转发 '+s.relayCount+' / 原始 '+s.count):esc(s.error||'失败'))+'</div></div>').join('')||'<div class="loading">未配置源项目</div>';
  }catch(e){el.innerHTML='<div class="error">检测失败：'+esc(e.message)+'</div>'}
}

// 事件委托：订阅卡片按钮不再使用嵌套引号的 inline onclick，避免“按钮点不了”。
document.addEventListener('click',function(event){
  const copyBtn=event.target.closest('[data-action="copy"]');
  if(copyBtn){event.preventDefault();copyText(copyBtn.dataset.url);return;}
  const qrBtn=event.target.closest('[data-action="qr"]');
  if(qrBtn){event.preventDefault();showQR(qrBtn.dataset.url,qrBtn.dataset.title);return;}
  const shadowBtn=event.target.closest('[data-action="shadowrocket"]');
  if(shadowBtn){event.preventDefault();openShadowrocket(shadowBtn.dataset.url);return;}
  if(event.target===document.getElementById('qrModal'))closeQR();
});

loadClientLinks();
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function subscriptionCard(name, url, shadowrocket) {
  const safeUrl = String(url || '');
  const safeName = String(name || '订阅');
  return `<div class="subscription-card">
    <h3>${escapeHtml(safeName)}</h3>
    <div class="subscription-link" data-action="copy" data-url="${escapeHtml(safeUrl)}" title="点击复制">${escapeHtml(safeUrl)}</div>
    <div class="button-group">
      <button type="button" class="btn primary" data-action="copy" data-url="${escapeHtml(safeUrl)}">📋 复制</button>
      <button type="button" class="btn secondary" data-action="qr" data-url="${escapeHtml(safeUrl)}" data-title="${escapeHtml(safeName)}">📱 二维码</button>
      ${shadowrocket ? `<button type="button" class="btn shadow" data-action="shadowrocket" data-url="${escapeHtml(safeUrl)}">🚀 配置到小火煎</button>` : ''}
    </div>
  </div>`;
}

function h5Css() {
  return `:root{--bg:#f4f7f9;--card:#fff;--primary:#4a90e2;--primary2:#357abd;--text:#333;--muted:#667085;--border:#e0e6ed;--green:#12b76a;--red:#f04438;--shadow:0 4px 12px rgba(0,0,0,.08)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;line-height:1.6}.container{max-width:1200px;margin:0 auto;padding:24px}.header{background:var(--card);border-radius:16px;padding:28px 30px;box-shadow:var(--shadow);margin-bottom:22px}.title-row{display:flex;align-items:center;justify-content:space-between;gap:20px}.header h1{margin:0;font-size:28px}.header p{margin:6px 0 0;color:var(--muted)}.status{font-size:14px;padding:8px 13px;border-radius:999px;background:#ecfdf3;color:#027a48;white-space:nowrap}.content-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;box-shadow:var(--shadow)}.wide{grid-column:1/-1}.card-title{font-size:19px;margin:0 0 18px}.expiry-inline{font-size:13px;font-weight:500;color:var(--muted);margin-left:10px;white-space:nowrap}.subscription-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.subscription-card{border:1px solid var(--border);border-radius:14px;padding:16px;background:#fbfcfe}.subscription-card h3{margin:0 0 10px;font-size:16px}.subscription-link,.config-value{word-break:break-all}.subscription-link{background:#f2f5f9;border-radius:9px;padding:11px;font-size:13px;color:#344054;cursor:pointer;min-height:54px}.button-group{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.btn{border:0;border-radius:9px;padding:9px 12px;color:#fff;cursor:pointer;font-size:13px}.primary{background:var(--primary)}.secondary{background:#667085}.shadow{background:#1d2939}.config-card{padding:13px 0;border-bottom:1px solid #eef1f4}.config-card:last-child{border-bottom:0}.config-label{font-size:13px;color:var(--muted);margin-bottom:3px}.config-value{font-size:14px}.source-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid #eef1f4}.source-row:last-child{border-bottom:0}.source-host{color:var(--muted);font-size:12px;margin-top:3px}.source-badge{font-size:12px;padding:7px 10px;border-radius:999px;white-space:nowrap}.source-badge.ok{background:#ecfdf3;color:#027a48}.source-badge.bad{background:#fef3f2;color:#b42318}.loading{color:var(--muted)}.error{color:#b42318}.footer{text-align:center;color:#98a2b3;font-size:12px;padding:24px}.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);background:#101828;color:#fff;padding:10px 16px;border-radius:9px;opacity:0;pointer-events:none;transition:.2s;z-index:100}.toast.show{opacity:1;transform:translate(-50%,0)}.modal{position:fixed;inset:0;background:rgba(16,24,40,.55);display:none;align-items:center;justify-content:center;padding:18px;z-index:99}.modal.show{display:flex}.modal-box{position:relative;background:#fff;border-radius:16px;padding:24px;max-width:340px;width:100%;text-align:center}.close{position:absolute;right:12px;top:8px;border:0;background:none;font-size:28px;color:#667085;cursor:pointer}.qr-url{font-size:12px;color:#667085;word-break:break-all;margin-top:10px}.client-links-panel{margin:18px auto 0;max-width:820px;padding:16px;background:linear-gradient(135deg,#f8fbff,#fff);border:1px solid var(--border);border-radius:16px;box-shadow:0 4px 12px rgba(74,144,226,.08)}.client-links-title{font-size:15px;font-weight:700;color:var(--muted);margin-bottom:12px;text-align:center}.client-links-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.client-link-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 12px;border-radius:12px;background:var(--primary);color:#fff;text-decoration:none;font-weight:700;font-size:14px;line-height:1.25;box-shadow:0 4px 12px rgba(74,144,226,.18);transition:all .2s ease;text-align:center}.client-link-btn:hover{background:var(--primary2);transform:translateY(-2px)}.client-link-btn.download{background:#f6821f;box-shadow:0 4px 12px rgba(246,130,31,.18)}.client-link-btn.download:hover{background:#e66f10}.client-links-loading,.client-links-empty{grid-column:1/-1;color:var(--muted);font-size:14px;text-align:center;padding:8px 0}.add-list{line-height:1.9;word-break:break-all}.client-links-panel a{cursor:pointer}.qr-url{font-size:12px;color:#667085;word-break:break-all;margin-top:10px}@media(max-width:820px){.client-links-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.client-link-btn{font-size:13px;min-height:42px}.content-grid{grid-template-columns:1fr}.wide{grid-column:auto}.subscription-grid{grid-template-columns:1fr}.title-row{align-items:flex-start;flex-direction:column}.container{padding:14px}.header{padding:20px}.card{padding:17px}.source-row{align-items:flex-start;flex-direction:column}.source-badge{white-space:normal}}@media(max-width:460px){.client-links-grid{grid-template-columns:1fr}.expiry-inline{display:block;margin:4px 0 0;white-space:normal}}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders } });
}
