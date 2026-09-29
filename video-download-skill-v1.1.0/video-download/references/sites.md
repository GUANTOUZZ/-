# 网站与排障

| 网站 | 接入方式 | 限制 |
|---|---|---|
| 央视 | cctv-dl H5E 专用路径，最高档 | 高清不可直接交给普通 HLS 拼接；本地实际分辨率校验 |
| 腾讯 | yt-dlp vqq，最高画质同档 CDN 切换 | 网页宣传的 1080P 不等于当前接口可取；会员内容另有限制 |
| 优酷 | yt-dlp youku | 部分视频需要登录、区域或账号条件 |
| 搜狐 | 专用候选 API + ffprobe | 自媒体 URL 已接入；其他节目类型不保证成功 |
| B站/b23.tv | yt-dlp BiliBili/短链接解析 | 高画质常需登录；只处理单个视频，不下载整套课程 |
| 抖音/TikTok | yt-dlp Douyin/TikTok | 常需有效 Cookie，风控或验证码会失败 |
| 微博 | yt-dlp Weibo | 可访问性与登录状态相关 |
| 小红书 | yt-dlp XiaoHongShu | 分享短链、登录和风控可能使解析失败 |
| YouTube | yt-dlp youtube | 可能需 JavaScript 运行时、登录或代理 |
| Instagram、Vimeo、X | yt-dlp 对应解析器 | 未逐站下载验证；授权可见范围内尝试 |
| 快手 | 暂无确认可用的专用链路 | 仅通用网页解析，不承诺支持 |

通用分支是已有解析器的复用，不是每个网站新写一套爬虫。支持名单与实际可下载状态不同，参见 [上游站点列表](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)。

## 故障处理

- `cookies` / 403 / 登录提示：在用户授权后使用其 Cookie，或报告访问受限；不要重复空跑。
- 最高格式某节点失败：脚本只尝试同档候选，全部失败则报错。
- ffprobe/ffmpeg 找不到：补齐 PATH；不要跳过完整性校验。
- 央视工具缺失：先按安装说明安装；无工具时普通备用路径不保证高清。
- MP4 封装不兼容：报告原格式；不要静默转码或降低画质。
- `.quality.json` 包含源视频 URL，仅与视频一起交给请求者，不作为通用 Skill 分享素材。
- 长视频默认每个下载进程最多 900 秒，可用 `--timeout` 调整；多候选与全片校验可能增加总耗时。
