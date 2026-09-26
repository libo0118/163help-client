# CHANGELOG

## 5.1.1 (2026-09-26) —— 服务端门控/签名对齐修复（预发布）
- 版本号改三段式 `5.1.1`（服务端 `normalizeVersion` 要求 x.y.z 两段式；同时服务端已放宽为接受 1~3 段）
- 签名实现与服务端 `hmac.go` 逐字段对齐（此前 5.x 全系过不了签名校验，会 403 invalid_signature）：
  - 签名消息第 5 行改回「原始请求体」（旧版误用 body 的 HMAC 哈希）
  - URL 改「path+query 不含 host」（旧版误带完整 URL）
  - `mh_ck_` 客户端密钥改 SHA-256(key) 派生签名密钥（旧版误用 HMAC(key,'')）
  - 请求头统一 `X-Timestamp/X-Nonce/X-Signature`（userscript 旧为 `X-MH-*` 错名；扩展/docker 旧为不签）
- 403 `client_upgrade_required` → 停止循环并明示「版本不受支持，请更新脚本」（旧版 3s 无退避死循环，6 台 docker 24h 打空 5.4 万次请求）
- 403 响应体解析 error/minSupportedVersion/latestVersion，供提示与日志

## 5.1 (2026-09-06)
- popup 重做外部脚本 + 快照通道；面板设置弹层/诊断/日志落地；core limits:updated+log:append 真发射；错误上报三通道

## 5.0.0 (2026-09-02) —— 三端整体重构
- 新架构：monorepo（core/ui/三端），一个核心三端复用
- 严格心跳协议：30s 无首心跳放弃 / 45s 心跳中断放弃 / 冻结恢复续听；无心跳=无效重听
- UI 全新：网易云风白卡红标（跟随页面亮/暗主题），默认 44px 红圆球收起
- 客户端错误日志自动上报（error 即时/warn 聚类/双层脱敏；后台「客户端日志」页）
- 修复：nonce 重放 403、finish 缺 token、掉登录自检引导、全量中文文案
- 发布链：GitHub Actions 自动构建（zip+user.js+docker 镜像），verify-release.sh 8 项验收