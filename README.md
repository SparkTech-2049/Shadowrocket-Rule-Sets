# Shadowrocket-Rule-Sets

为 Shadowrocket 生成默认直连的分流规则。GitHub Actions 每天在新加坡时间约 09:24 采集并验证上游，GitHub 调度可能延迟。规则内容有变化时才提交，新产物以同一个 Git 提交发布。可在 Actions 页手动运行 **Update Shadowrocket rules**。

| 文件 | 用途 |
| --- | --- |
| [direct.list](dist/direct.list) | 可通过 `RULE-SET` 引用，并在配置中指派 `DIRECT` |
| [proxy.list](dist/proxy.list) | 可通过 `RULE-SET` 引用，并在配置中指派代理组 |
| [shadowrocket.rules](dist/shadowrocket.rules) | 供 MiSub 内嵌到完整配置的规则片段 |
| [manifest.json](dist/manifest.json) | 产物 SHA-256、来源状态、输入和发布条数 |

`rules/` 保存自有基础规则，`sources.json` 保存批准采集的来源。构建仅接收明确域名、域名后缀和有效公网 IPv4 网段，舍弃上游脚本、节点、DNS、关键字匹配、兜底和二级链接。已确认的国内域名优先。公开产物不含节点凭据或个人订阅信息。接入 MiSub 时，AI 专用策略在前，最后由完整配置设定 `FINAL,DIRECT`。

上游时间以文件标注的发布时间为初始值。后续比较规范化规则的指纹，仅内容变化时更新该来源的有效时间。超过三个日历月没有内容变化的来源从新产物退出。上游临时故障或内容异常将使构建失败，GitHub 保留上次成功发布的产物。

本地可使用 Node.js 22 或更新版本运行 `node --test` 和 `node scripts/update.mjs`。

## 上游授权

- Johnshall 和 Moshel 的黑名单规则来自 [Shadowrocket-ADBlock-Rules-Forever](https://github.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever)，保留 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授权。采集时仅保留代理匹配条目，并做规范化和去重。
- blackmatrix7 的代理域名来自 [ios_rule_script](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Shadowrocket/Proxy)，保留 [GPL 2.0](LICENSES/GPL-2.0.txt) 授权。采集时转换成 Shadowrocket 规则语法并去重。
- 生成文件中的来源注释保留各段归属和授权。各来源的原始路径及本仓库的转换代码可分别在 `sources.json` 和 `scripts/` 中查阅。
Automatically collected, deduplicated Shadowrocket routing rules with source tracking and validation.
