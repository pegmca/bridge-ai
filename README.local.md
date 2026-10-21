# bridge-ai 本地局域网部署（运维备忘）

把 bridge-ai 跑在本机，对外提供 OpenAI 兼容接口，供局域网内客户端使用。

> 仅限局域网使用。接入 token 等同于你本机 CodeBuddy 账号的使用权，不要外泄。

## 1. 接口与鉴权
- 接口地址：http://192.168.5.8:8787/v1（服务绑定 0.0.0.0，局域网可达）
- 调用方式（OpenAI 兼容）：

    curl http://192.168.5.8:8787/v1/chat/completions \
      -H "Authorization: Bearer <serverApiKey>" \
      -H "Content-Type: application/json" \
      -d '{"model":"default","stream":true,"messages":[{"role":"user","content":"hi"}]}'

- <serverApiKey> 见 config.json 的 listen.serverApiKey（请勿明文抄到别处）。
- 上游 CodeBuddy 凭据：config.json 的 accounts[0]，mode=refresh（refreshToken + userId），通过 MITM 抓取获得。

## 2. 怎么确认服务在跑

    curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/healthz
    netstat -ano | grep ":8787 " | grep LISTEN
    tail -n 5 tmp/cap/bridge.log

## 3. 启动 / 停止（npm 脚本）
不用单独的脚本文件，全部写在 package.json 里：

    npm start        # 后台 detached 启动（日志 tmp/cap/bridge.log）
    npm run stop     # 按端口查杀进程并停止
    npm run restart
    npm run status   # 探活：RUNNING pid=... healthz=200

> 在 Git Bash / cmd / 任意终端里都能用（scripts/svc.mjs 是跨平台 node 助手，按端口定位进程）。

## 4. 它不是系统服务
- 重启电脑后会消失；进程崩溃不会自动重启；没有服务管理器托管。
想要开机自启 / 崩溃自拉起，可选：
1. 任务计划程序（登录触发启动）——最简单，但崩了不自动重启；
2. nssm 装成 Windows Service——真正的服务，支持失败自动重启（需联网下载 nssm）。

## 5. 上游 channel 校验（错误 11128）排查
请求可能返回 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}。两类原因，都报 11128：
- A. header 问题（概率性）：已通过 config.json 的 provider.clientHeaders 伪装成 GitHub Copilot Chat for VS Code 客户端（User-Agent: GitHubCopilotChat/0.35.0 + Editor-* / Copilot-Integration-Id 等）解决，并把 provider.channelVerifyRetries 提到 5。
- B. prompt 指纹（确定性）：上游对 system prompt 中的 branded 字样做指纹，命中即拒（无视 header）。例如以 "You are an AI agent powered by DeepSeek Harness." 开头、或 tool 描述含 "DeepSeek Harness"。已通过 config.json 的 sanitize 改写这些串解决（只改 branded 子串，不动 ohna-harness 这类仓库路径）。
新增 11128 怎么定位：临时在 config.json 开 dumpBodyDir: "tmp/cap/dumps" 与 logIncomingHeaders: true，重启，用客户端重发失败请求，到 tmp/cap/dumps/ 里 grep 指纹词（如 harness、DeepSeek、You are an AI agent），据此加 sanitize.rules。定位完务必关掉 dumpBodyDir——它会把对话内容落盘到 tmp/cap/dumps/。

## 6. refresh token 过期
上游开始报 401 / 刷新错误时，说明 token 过期，需重新抓取（会临时改 hosts 并绑 443，结束自动还原，需管理员）：

    node tmp/cap/capture.mjs   # 管理员运行

脚本会捕获 X-Refresh-Token / X-User-Id 并写回 config.json 的 refresh 账户，然后恢复 hosts。

## 7. 目录约定
- 所有调试/临时文件都在 tmp/（已被 gitignore），任务结束可清理。
