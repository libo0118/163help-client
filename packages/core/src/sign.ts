/**
 * API 签名（必须与服务端 server-go hmac.go 逐字段一致；以 legacy
 * client-docker/signing.js —— 线上 4.x 客户端验证过的实现 —— 为准。
 * 2026-09-26 预发布修复：旧版 5.x core 的签名消息第 5 行误用「body 的 HMAC
 * 哈希」、mh_ck_ 密钥误用 HMAC(key,'') 而非 SHA-256(key)、URL 误带 host、
 * 各端请求头名不一致（X-MH-* / 干脆不签），导致 5.x 客户端即便过了版本
 * 门控也会在签名校验处 403 invalid_signature。）
 *
 * 约定：
 *   签名消息 = METHOD + "\n" + path+query（不含 host）+ "\n" + timestamp + "\n" + nonce + "\n" + 原始请求体
 *   算法 = HMAC-SHA256，输出小写 hex
 *   密钥 = 会话 token 原文；mh_ck_ 客户端密钥 = SHA-256(密钥) 小写 hex（服务端只存 key 的哈希）
 *   请求头 = X-Timestamp / X-Nonce / X-Signature
 *
 * 关键：nonce 每次请求全新生成（修复「重试复用 nonce → 403 疑似重放」）。
 * 浏览器环境：hmacFn/sha256HexFn 由各端注入（crypto.subtle 实现），core 不直接依赖运行时 API。
 */

export type HmacFn = (secret: string, data: string) => Promise<string>;
export type Sha256HexFn = (data: string) => Promise<string>;
export type NonceFn = () => string;

export interface SignHeaders {
  a: string; // nonce
  t: string; // unix 秒
  s: string; // hmac
}

const CLIENT_KEY_PREFIX = 'mh_ck_';

/** 无法签名（无 token）时返回 null，调用方降级不签名 */
export async function buildSignHeaders(
  method: string,
  fullUrl: string,
  rawBody: string,
  token: string,
  hmacFn: HmacFn,
  sha256HexFn: Sha256HexFn,
  nonceFn: NonceFn,
): Promise<SignHeaders | null> {
  if (!token) return null;
  // 服务端用 r.URL.RequestURI()（path+query、不含 host）验签，必须对齐
  const u = new URL(fullUrl);
  const pathAndQuery = u.pathname + u.search;
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = nonceFn(); // 每次全新，绝不复用
  // 签名消息第 5 行是「原始请求体」字符串（不是 body 的哈希）；GET/无 body 为 ''
  const norm = `${String(method).toUpperCase()}\n${pathAndQuery}\n${ts}\n${nonce}\n${rawBody ?? ''}`;
  // 客户端密钥（mh_ck_）用 SHA-256(key) 小写 hex 作签名密钥（服务端 tokenHash）；会话 token 用原文
  const secret = token.startsWith(CLIENT_KEY_PREFIX) ? await sha256HexFn(token) : token;
  return { a: nonce, t: ts, s: await hmacFn(secret, norm) };
}

export const hexBytes = (bytes: Uint8Array) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/** crypto.subtle 实现的 HMAC-SHA256（浏览器/Node18+ 通用） */
export async function subtleHmac(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return hexBytes(new Uint8Array(sig));
}

/** SHA-256 小写 hex（mh_ck_ 客户端密钥的签名密钥派生；浏览器/Node18+ 通用） */
export async function subtleSha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return hexBytes(new Uint8Array(digest));
}

/** 浏览器 nonce：crypto.getRandomValues（16 字节 hex） */
export function browserNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hexBytes(b);
}
