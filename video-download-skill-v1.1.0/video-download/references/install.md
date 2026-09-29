# 安装与分享

将 ZIP 解压，保留完整的 `video-download` 文件夹。Codex 用户可放到 `~/.codex/skills/video-download`，重新打开会话后调用 `$video-download`。其他支持 SKILL.md 的宿主按其规则导入。脚本也能独立运行。

推荐在 Skill 外创建虚拟环境，避免把环境再次分享出去：

```powershell
python -m venv .video-download-venv
.video-download-venv\Scripts\python.exe -m pip install -r "<skill-dir>/scripts/requirements.txt"
```

后续命令使用这个环境里的 Python。macOS/Linux 对应 `.video-download-venv/bin/python`。

安装 FFmpeg（包含 ffprobe）与 curl，并加入 PATH。Windows 可使用 `winget install Gyan.FFmpeg`；macOS 可使用 `brew install ffmpeg`；Ubuntu 可使用 `sudo apt install ffmpeg curl`。这些命令由用户或宿主按当前环境执行，不自动提权或修改系统策略。

## 央视

Windows x64：

```powershell
python "<skill-dir>/scripts/install_cctv.py"
```

必要时加 `--proxy http://127.0.0.1:7890`，不在代码里保存代理配置。安装脚本仅从上游下载固定版本并验证 SHA256，不执行运行库安装程序。

macOS/Linux 从上游发行页安装对应平台的 `cctv-dl`，下载时传 `--cctv-cli "/absolute/path/cctv-dl"`。其他平台尚未实机验证。

## 依赖与来源

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)：站点解析；本包锁定 2026.8.19。
- [CCTVVideoDownloader](https://github.com/letr007/CCTVVideoDownloader)：央视 H5E 处理，独立可执行程序，GPL-3.0；Windows 固定 v4.4.4。
- [央视发行包](https://github.com/letr007/CCTVVideoDownloader/releases/tag/v4.4.4)。SHA256：`ed251185cab5ee49f1e8d7681937df3c3b4fb263c9c99963e5a33c8f5e811e24`。
- [FFmpeg](https://ffmpeg.org/)：不重新编码的封装与解码校验。

分享包不包含第三方可执行程序、Python 环境、视频、Cookie、日志或账号配置。各依赖保留其原许可证；若自行重分发第三方二进制，请一并遵守其许可证要求。

首次安装需要联网。网站失效时可升级 yt-dlp，但应记录新版本并重新验证。YouTube 某些链接还要求受支持的 JavaScript 运行时，按 yt-dlp 的 EJS 文档安装，不把“解析器存在”当作已下载成功。
