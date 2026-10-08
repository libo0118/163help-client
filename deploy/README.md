# ARM64 Docker + Nginx 部署

上游 v5.1 发布镜像只有 linux/amd64；Playwright v1.47.0-noble 基础镜像包含 ARM64。本分支可在 ARM64 服务器原生构建，也为 GitHub 镜像工作流加入双架构构建，并将推送目标改为当前 fork。

源码放在 `/opt/163help-client/source`，持久化目录为 `/opt/163help-client/data`。另建仅管理员可读的 `/opt/163help-client/.env`，设置强随机 `UI_PASSWORD` 和 `DATA_DIR=/opt/163help-client/data`；不要提交账号、Cookie、密码或数据目录。

```sh
docker compose --project-name music163 --env-file /opt/163help-client/.env \
  -f /opt/163help-client/source/deploy/compose.yaml up -d --build
```

容器设为自动重启，内存上限 1 GiB，日志轮转，宿主端口仅绑定 `127.0.0.1:13000`。把 `nginx-music.conf` 放到 `/etc/nginx/snippets/163help-music.conf`，在已有网站的 `server` 中加入：

```nginx
include /etc/nginx/snippets/163help-music.conf;
```

先运行 `nginx -t` 再 reload。访问现有网站的 `/music/`。此配置改写上游内联脚本的 `/api/` 地址并限定登录 Cookie 路径，不修改网站默认首页。使用已有 HTTPS 网站入口填写账号凭据。

已修复上游配置 API 在未注册保存回调时仍返回成功的问题：校验并映射页面的 cookie/key，原子写入 `/data/session.json`（0600），响应后退出进程，由 Docker 重启并加载新账号。退出登录会撤销会话；状态 API 显示是否已配置。账号留空时等待用户配置，不代填测试账号。

在 Node 22.18+ / 24 运行管理接口检查：

```sh
node apps/docker/config-smoke.mjs
```

该检查不访问网易云、不领取任务、不使用真实账号。实际播放需配置用户自己的网易云 Cookie 和 Portal 客户端密钥后再验证。
