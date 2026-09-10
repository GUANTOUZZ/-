---
name: video-download
description: 将央视、腾讯、优酷、搜狐、B站及 yt-dlp 支持的视频页面下载到本地，优先最高可访问画质并校验文件。用于获取视频文件，不用于内容审核、转写、直播录制或批量爬取账号。
---

# 本地高清视频下载

使用 `scripts/download.py`，不要重新拼接临时下载脚本。纯下载不调用语言模型 API；下载工具本身无 GPT 额度费用，运行此 Skill 的宿主智能体可能仍计费。

## 首次使用

首次安装请阅读根目录 [安装操作说明](安装操作说明.md)，依赖来源见 [安装参考](references/install.md)。要求 Python 3.11+、FFmpeg/ffprobe、curl；`yt-dlp` 安装在运行脚本的同一个 Python 环境。央视使用独立的 `cctv-dl`，不要把普通 yt-dlp 的 270P 结果当作央视最高画质。

## 工作流程

1. 从用户消息提取单条视频链接。保留用户指定的输出目录；没有指定时用当前工作目录的 `downloads`。仅下载用户要求的视频，不扩展为账号或播放列表爬取。
2. 执行下面的命令。替换路径为本 Skill 所在目录，所有路径和 URL 使用独立参数，不拼成 shell 命令片段。

```powershell
python "<skill-dir>/scripts/download.py" "https://example.com/video" --output "<output-dir>"
```

3. 脚本 stdout 最后一行是 JSON：`ok`、`path`、`quality_report`。只有退出码 0 且 `ok=true` 才交付文件。读取 `.quality.json`，报告实际分辨率、时长、大小和绝对文件链接，不按网页的“1080P”标题猜测画质。
4. 失败时报告具体阶段和下一步。不要发送 `.part`、TS 临时分片或宣称“已下载”后隐藏上传失败。下载成功不等于外部发送成功，本 Skill 不负责上传或群发。

## 画质与稳定性

- “最高”指当前访问身份、地区和网站接口实际返回的可用画质，不保证源站母版或会员最高档。
- 通用路径先列格式，再按分辨率、码率、帧率排序；分离音视频取最高画质视频并合并音轨。不能合并时报告错误，不重新编码降质。
- 腾讯同画质优先首个 CDN；失败仅重试同等画质节点。搜狐读取候选流实际分辨率。央视走 H5E 专用工具，输出仍须通过本地解码检查。
- 不以放大分辨率、插帧或转码冒充更高清。缺片、中途超时、实际分辨率不足时不当作完成。
- 每次下载使用独立目录。超时终止该任务的子进程，不操作其他下载或用户浏览器。

## 登录、代理与例外

需要登录时，使用用户授权的 Cookie 文件或明确指定的浏览器；不自动读取所有浏览器，不复制凭据到报告或分享包。

```powershell
python "<skill-dir>/scripts/download.py" "<url>" --cookies "<cookies.txt>"
python "<skill-dir>/scripts/download.py" "<url>" --cookies-from-browser chrome
python "<skill-dir>/scripts/download.py" "<url>" --proxy "http://127.0.0.1:7890"
python "<skill-dir>/scripts/download.py" "<url>" --list-formats
```

浏览器 Cookie 被占用时报告原因，不强行关闭浏览器。登录不保证会员/付费/DRM 视频可下载。不要承诺绕过访问权限或验证码。

查看 [网站与排障](references/sites.md) 获取站点限制；查看 [验证记录](references/validation.md) 区分实测和仅解析器支持。网站变化会导致失效，更新依赖后仍需重新确认。
