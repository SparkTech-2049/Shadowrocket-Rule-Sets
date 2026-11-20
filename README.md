# Shadowrocket-Rule-Sets

为 Shadowrocket 生成默认直连的分流规则。GitHub Actions 每天在新加坡时间约 09:24 采集正式来源，每周一约 10:47 发现候选。GitHub 调度可能延迟。两项任务也可在 Actions 页手动运行。

| 文件 | 用途 |
| --- | --- |
| [direct.list](dist/direct.list) | 可通过 `RULE-SET` 引用，并在配置中指派 `DIRECT` |
| [proxy.list](dist/proxy.list) | 可通过 `RULE-SET` 引用，并在配置中指派代理组 |
| [shadowrocket.rules](dist/shadowrocket.rules) | 供 MiSub 内嵌到完整配置的规则片段 |
| [manifest.json](dist/manifest.json) | 产物 SHA-256、来源状态、输入和发布条数 |
| [候选来源报告](reports/candidates.json) | 规则文件、最近内容变化日期、上游出处、重复数量和新增覆盖 |

`rules/` 保存自有基础规则，`sources.json` 保存批准采集的来源。构建仅接收明确域名、域名后缀和有效公网 IPv4 网段，舍弃上游脚本、节点、DNS、关键字匹配、兜底和二级链接。已确认的国内域名优先。公开产物不含节点凭据或个人订阅信息。接入 MiSub 时，AI 专用策略在前，最后由完整配置设定 `FINAL,DIRECT`。

### 正式来源

规则发布时间取自文件标注，支持用已配置的 GitHub 规则文件历史回退。程序比较规范化内容的指纹，只有真实内容变化才移动这个日期。成功验证的规则内容超过三个日历月没有变化，该来源标记为 `retired`，从新产物退出。重新出现有效新内容时可以恢复。

每个正式来源在 `snapshots/` 保存独立的已验证规则，内容指纹记在 `dist/manifest.json`。临时下载或校验失败时，校验并复用该来源的快照，状态标为 `cached`，其余来源仍可发布。尚无旧产物的新来源失败时标为 `unavailable`。所有来源都无法验证，或已有正式来源的快照校验失败时，保留上一版完整产物。规则文件、快照和清单在同一提交发布。

### 候选来源

发现任务搜索 GitHub 的 Shadowrocket 主题和关键词，也跟踪正式来源注明的数据出处。仓库活跃度用于初筛，实际资格取决于规则文件、文件历史、声明的许可证与可追溯来源。报告评估明确的代理类文件，计算已覆盖或重复项、与直连的冲突，以及可补充的规则数量。候选状态来自这轮自动检查，接入正式来源前仍要核对具体文件和上游许可，并验证分流。经审核的来源通过 `sources.json` 加入正式采集，可用 `history` 的 `repo`、`ref` 和 `path` 指定 GitHub 文件历史。

本地可使用 Node.js 22 或更新版本运行 `node --test`、`node scripts/update.mjs` 和 `node scripts/discover.mjs`。GitHub API 的可选 `GH_TOKEN` 由 Actions 提供。发现任务只读公开资料，提交的报告只包含公开规则来源信息。

## 上游授权

- Johnshall 和 Moshel 的黑名单规则来自 [Shadowrocket-ADBlock-Rules-Forever](https://github.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever)，保留 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授权。采集时仅保留代理匹配条目，并做规范化和去重。
- blackmatrix7 的代理域名来自 [ios_rule_script](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Shadowrocket/Proxy)，保留 [GPL 2.0](LICENSES/GPL-2.0.txt) 授权。采集时转换成 Shadowrocket 规则语法并去重。
- 生成文件中的来源注释保留各段归属和授权。各来源的原始路径及本仓库的转换代码可分别在 `sources.json` 和 `scripts/` 中查阅。
