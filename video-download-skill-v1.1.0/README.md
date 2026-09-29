# video-download

本地高清视频下载 Skill，版本 **1.1.0**。

用于将央视、腾讯、优酷、搜狐、B站以及 `yt-dlp` 支持的视频页面下载到本地，优先选择当前访问身份、地区和站点接口实际可访问的最高画质，并对最终文件做基础校验。

> 本 Skill 用于获取视频文件，不用于内容审核、转写、直播录制或批量爬取账号。

## 功能

- 下载单条视频链接
- 优先最高可访问画质
- 支持分离音视频后合并
- 下载后输出实际分辨率、时长、大小等质量报告
- 支持浏览器 Cookie / Cookie 文件
- 支持 HTTP 代理
- 支持央视专用下载链路
- 可独立通过命令行运行
- 可接入 Codex 或其他支持 `SKILL.md` 的智能体

纯下载过程本身不调用语言模型 API，因此下载工具本身没有 GPT API 费用；如果通过智能体宿主调用本 Skill，宿主本身仍可能产生模型使用费用。

---

## 支持范围

当前 Skill 面向以下来源：

- 央视
- 腾讯视频
- 优酷
- 搜狐
- Bilibili
- 其他 `yt-dlp` 支持的视频页面

其中央视使用独立的 `cctv-dl` 链路，不应把普通 `yt-dlp` 返回的低清结果当成央视最高画质。

**快手目前没有确认可用的专用链路，不承诺支持。**

网站会持续改版，解析能力也可能随时间变化。完整站点范围与限制请查看：

- [`references/sites.md`](references/sites.md)
- [`references/validation.md`](references/validation.md)

---

## 推荐环境

推荐：

- Windows 10 / 11 64 位
- Python 3.11+
- FFmpeg
- ffprobe
- curl

完整安装过程请直接阅读：

**[安装操作说明.md](安装操作说明.md)**

---

## 目录结构

```text
video-download/
├─ README.md
├─ SKILL.md
├─ 安装操作说明.md
├─ agents/
├─ references/
│  ├─ sites.md
│  ├─ validation.md
│  └─ install.md
└─ scripts/
   ├─ download.py
   ├─ install_cctv.py
   └─ requirements.txt
```

不要只复制其中一个 Python 文件。建议始终保留整个 `video-download` 文件夹。

---

## 快速安装

进入 Skill 目录：

```powershell
Set-Location "$HOME\Downloads\video-download"
```

创建独立 Python 虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r .\scripts\requirements.txt
```

检查 FFmpeg：

```powershell
ffmpeg -version
ffprobe -version
curl.exe --version
```

如果 Windows 上没有 FFmpeg，可使用：

```powershell
winget install --id Gyan.FFmpeg --exact
```

安装完成后重新打开 PowerShell。

---

## 安装央视专用组件

央视高清下载需要额外组件：

```powershell
.\.venv\Scripts\python.exe .\scripts\install_cctv.py
```

安装器会下载固定版本、检查 SHA256，并将相关文件放入 Skill 的 `tools` 目录。

如果 GitHub 访问需要代理：

```powershell
.\.venv\Scripts\python.exe .\scripts\install_cctv.py --proxy http://127.0.0.1:7890
```

`7890` 只是示例端口，请替换成你自己的代理配置。

---

## 首次下载

示例：

```powershell
.\.venv\Scripts\python.exe .\scripts\download.py "https://tv.cctv.com/2017/03/17/VIDE1rV2if1tZy9Wug7FDTln170317.shtml" --output "$HOME\Downloads\Videos"
```

其他网站只需替换 URL。

默认只下载用户指定的单条视频，不扩展为整个账号、频道或播放列表批量抓取。

如果不指定 `--output`，默认输出到当前工作目录下的：

```text
downloads/
```

每次任务使用独立子目录，避免旧任务残片被误判成新结果。

---

## 下载结果

脚本 stdout 最后一行会输出 JSON，关键字段包括：

```json
{
  "ok": true,
  "path": "...",
  "quality_report": "..."
}
```

只有在：

- 退出码为 `0`
- 且 `ok=true`

时，才应认为下载完成。

旁边的 `.quality.json` 会记录实际媒体信息，例如：

- `width`
- `height`
- `duration`
- `size`
- stream 信息

不要只根据网页写着“1080P”或文件名判断真实画质。

---

## 什么叫“最高画质”

这里的“最高画质”指：

**当前访问身份、地区和网站接口实际返回的最高可访问画质。**

它不等于：

- 源站母版最高质量
- 会员最高档
- DRM 受保护内容
- 未授权访问级别

工具不会通过放大分辨率、插帧或重新编码来冒充更高清。

通用下载路径会先列出格式，再按照分辨率、码率、帧率选择；如果音视频分离，则下载最高画质视频流并合并音轨。

只查看站点当前返回的格式：

```powershell
.\.venv\Scripts\python.exe .\scripts\download.py "视频链接" --list-formats
```

---

## 登录与 Cookie

如果视频需要登录，可使用自己授权的登录态。

直接读取浏览器 Cookie：

```powershell
.\.venv\Scripts\python.exe .\scripts\download.py "视频链接" --cookies-from-browser chrome --output "$HOME\Downloads\Videos"
```

也可尝试：

- Chrome
- Edge
- Firefox

具体取决于 `yt-dlp` 支持情况。

使用 Netscape 格式 Cookie 文件：

```powershell
.\.venv\Scripts\python.exe .\scripts\download.py "视频链接" --cookies "$HOME\Downloads\cookies.txt"
```

不要把自己的 Cookie 文件发送给别人，也不要把 Cookie 打包进分享版本。

登录态并不代表一定可以下载会员、付费或 DRM 内容。

---

## 代理

如果网络需要代理：

```powershell
.\.venv\Scripts\python.exe .\scripts\download.py "视频链接" --proxy http://127.0.0.1:7890
```

代理会作用于 `yt-dlp`、Python 请求以及部分央视恢复流程。

央视原生组件是否使用环境代理，还取决于 Qt / 系统网络配置，因此不能保证所有请求都一定经过同一个代理参数。

---

## 央视超时与恢复

1.1.0 针对央视原生下载增加了恢复机制。

单次卡住的原生进程不会无限等待；停止后会检查分片状态，尝试补齐缺失分片，再恢复处理。

默认总预算：

```text
900 秒
```

慢网络或长视频可以增加：

```powershell
.\.venv\Scripts\python.exe .\scripts\download.py "央视链接" --timeout 1800 --output "$HOME\Downloads\Videos"
```

恢复日志位于任务目录：

```text
cctv_native/recovery.json
```

当前不会跨不同命令任务自动续传；重新运行会建立新的任务目录。

---

## 接入 Codex

确认命令行模式已经可以正常运行后，把整个 `video-download` 文件夹复制到：

### Windows

```text
%USERPROFILE%\.codex\skills\video-download
```

### macOS / Linux

```text
~/.codex/skills/video-download
```

如果设置了 `CODEX_HOME`，则放到对应目录下的 `skills` 文件夹。

在最终安装位置重新创建 `.venv` 并安装依赖，因为 Python 虚拟环境不适合直接搬迁。

之后重新打开会话，可以对智能体说：

```text
使用 $video-download，把这个链接的视频以最高可访问画质下载到本地。
```

其他支持 `SKILL.md` 的宿主，可以按照其自身的 Skill 导入方式安装。

---

## 常见问题

### `No module named yt_dlp`

确认执行的是 Skill 自己的虚拟环境：

```powershell
.\.venv\Scripts\python.exe
```

并使用同一个解释器安装 `requirements.txt`。

### 找不到 `ffmpeg` / `ffprobe`

添加 PATH 后重新打开 PowerShell，并分别运行：

```powershell
ffmpeg -version
ffprobe -version
```

### 403 / 验证码 / 登录失败

先确认浏览器中本身可以播放。

在授权范围内使用自己的 Cookie，不要无限重试验证码或尝试绕过访问权限。

### 央视提示缺少专用工具

执行：

```powershell
.\.venv\Scripts\python.exe .\scripts\install_cctv.py
```

并保留 `tools` 下完整目录，不要只移动一个 EXE。

### 下载后没有可交付 MP4

查看终端错误和任务目录日志。

不要使用：

- `.part`
- 临时 TS 分片
- 未完成文件

### 实际分辨率低于网页显示

检查：

- 登录状态
- 网站接口实际返回的格式
- `.quality.json`

工具不会通过人工放大来伪造高清。

### 优酷偶尔超时

确认站点网络连接，必要时显式设置代理。

网络失败并不等于该格式本身不受支持。

### 快手失败

当前尚无确认可用的专用链路，因此不承诺支持。

---

## 安全与权限边界

本 Skill 不用于：

- 绕过 DRM
- 绕过付费权限
- 破解会员内容
- 自动解决验证码
- 未授权读取账号凭据
- 批量爬取整个账号
- 直播录制
- 内容审核
- 自动转写

只使用你有权访问和下载的内容。

---

## 分享给别人

推荐直接分享原始 Skill 文件夹或原始 ZIP。

**不要把以下内容重新打包进去：**

- `.venv`
- `tools` 中你本机安装后的运行环境
- 已下载视频
- Cookie
- `.quality.json`
- 下载日志
- 其他账号登录态

接收者应当在自己的电脑上重新安装依赖。

---

## 更新 yt-dlp

站点改版导致解析失效时，可以在虚拟环境内更新：

```powershell
.\.venv\Scripts\python.exe -m pip install --upgrade "yt-dlp[default]"
```

注意：更新依赖后，旧版本的验证记录不再代表新版本一定仍然通过测试。

---

## 更多文档

- [安装操作说明.md](安装操作说明.md)
- [网站与排障](references/sites.md)
- [验证记录](references/validation.md)
- [安装参考](references/install.md)
- [SKILL.md](SKILL.md)

---

## Version

**1.1.0**
