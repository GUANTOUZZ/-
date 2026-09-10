import asyncio
import base64
import json
import os
import re
import subprocess
import urllib.request
import uuid
import sys
import shutil
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urljoin

@dataclass
class Settings:
    ytdlp_cli: str = "yt-dlp"
    video_url_download_timeout_seconds: int = 900
    ytdlp_cookies_file: str = ""
    ytdlp_cookies_from_browser: str = ""
    proxy: str = ""
    cctv_cli: str = ""


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DOWNLOAD_ROOT = Path.cwd() / "downloads"
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}


async def download_video_from_text(text: str, message_id: str, settings: Settings) -> Path | None:
    url = extract_first_url(text)
    if not url:
        return None
    return await asyncio.to_thread(_download_video_sync, url, message_id, settings)


def extract_first_url(text: str) -> str | None:
    match = URL_RE.search(text or "")
    if not match:
        return None
    value = match.group(0).rstrip("。），,)")
    return re.sub(r"(?i)(\.(?:s?html|mp4|m3u8))(?:下载|审核|给我|发我).*$", r"\1", value)


def has_url(text: str) -> bool:
    return extract_first_url(text) is not None


def _download_video_sync(url: str, message_id: str, settings: Settings) -> Path:
    download_dir = DOWNLOAD_ROOT / _safe_stem(message_id) / uuid.uuid4().hex[:12]
    download_dir.mkdir(parents=True, exist_ok=True)

    host = (urlsplit(url).hostname or "").lower()
    if host == "cctv.com" or host.endswith(".cctv.com"):
        return _download_with_cctv(url, download_dir, settings)

    errors: list[str] = []
    downloaders = (_download_with_sohu,) if host == "sohu.com" or host.endswith(".sohu.com") else (_download_with_ytdlp,)
    for downloader in downloaders:
        try:
            video = downloader(url, download_dir, settings)
            if video.exists():
                return video
        except Exception as exc:
            errors.append(str(exc))

    detail = "\n".join(errors)[-1600:] if errors else "没有可用下载器"
    raise RuntimeError(f"视频链接下载失败：{detail}")


def _download_with_cctv(url: str, download_dir: Path, settings: Settings) -> Path:
    page = _fetch_text(url)
    match = re.search(r'''(?:\bguid|\bvideoCenterId)\s*[=:]\s*["']([0-9a-fA-F]{32})["']''', page)
    if not match:
        raise RuntimeError("央视页面未返回视频 ID，无法确认最高画质")
    video_id = match.group(1)
    info = json.loads(_fetch_text(
        f"https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid={video_id}"
    ))
    manifest = info.get("manifest") or {}
    sources = [manifest.get("hls_enc_url"), manifest.get("hls_enc2_url"),
               manifest.get("hls_h5e_url"), info.get("hls_url")]
    variants = []
    for source in dict.fromkeys(sources):
        if not source:
            continue
        try:
            playlist = _fetch_text(source)
        except Exception:
            continue
        variants.extend(_cctv_variants(playlist, source))
    variants = list(dict.fromkeys(variants))
    if not variants:
        raise RuntimeError("央视清晰度列表读取失败，请稍后重试")
    variants.sort(key=lambda item: (item[0], item[1]), reverse=True)
    best_quality = variants[0][:2]
    errors = []
    executable = Path(settings.cctv_cli) if settings.cctv_cli else PROJECT_ROOT / "tools" / "cctv-dl" / "v4.4.4" / "cctv-dl" / "bin" / "cctv-dl.exe"
    if executable.is_file():
        try:
            folder = download_dir / "cctv_native"
            folder.mkdir(parents=True, exist_ok=True)
            command = [
                str(executable), "download", "--guid", video_id, "--title", video_id,
                "--output", str(folder.resolve()), "--quality", "0", "--threads", "4", "--mp4", "--json"
            ]
            _run_cctv_resumable(command, folder, settings)
            path = _latest_video(folder)
            _validate_cctv_file(path, best_quality[0], settings)
            final = download_dir / f"{_safe_stem(info.get('title') or video_id)}-{video_id}.mp4"
            path.replace(final)
            _record_quality(final, url, "cctv-dl v4.4.4", best_quality[0])
            return final.resolve()
        except Exception as exc:
            errors.append(f"cctv-dl: {exc}")
    video = info.get("video") or {}
    chapter_keys = sorted(
        (key for key in video if re.fullmatch(r"chapters\d*", key)),
        key=lambda key: int(key.removeprefix("chapters") or 1), reverse=True
    )
    for key in chapter_keys[:1]:
        chapters = video[key]
        if not chapters or not all(item.get("url") for item in chapters):
            continue
        try:
            folder = download_dir / key
            folder.mkdir(parents=True, exist_ok=True)
            for index, chapter in enumerate(chapters):
                _download_url(chapter["url"], folder / f"part{index:04d}.mp4",
                              settings.video_url_download_timeout_seconds)
            listing = folder / "concat.txt"
            listing.write_text("".join(f"file 'part{i:04d}.mp4'\n" for i in range(len(chapters))), encoding="utf-8")
            path = folder / "complete.mp4"
            _run(["ffmpeg.exe", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                  "-c", "copy", str(path)], settings.video_url_download_timeout_seconds)
            _validate_cctv_file(path, best_quality[0], settings)
            final = download_dir / f"{_safe_stem(info.get('title') or video_id)}-{video_id}.mp4"
            path.replace(final)
            _record_quality(final, url, key, best_quality[0])
            return final.resolve()
        except Exception as exc:
            errors.append(f"{key}: {exc}")
    # Retry equivalent CDN sources, without silently falling back to lower quality.
    for attempt, (height, bandwidth, source) in enumerate(variants):
        if (height, bandwidth) != best_quality:
            continue
        try:
            attempt_dir = download_dir / f"source_{attempt}"
            attempt_dir.mkdir(parents=True, exist_ok=True)
            path = _download_with_ytdlp(source, attempt_dir, settings)
            _validate_cctv_file(path, height, settings)
            final = download_dir / f"{_safe_stem(info.get('title') or video_id)}-{video_id}.mp4"
            path.replace(final)
            metadata = {"page_url": url, "source": source, "height": height,
                        "bandwidth": bandwidth, "video_id": video_id}
            final.with_suffix(".quality.json").write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return final.resolve()
        except Exception as exc:
            errors.append(str(exc))
    (download_dir / "quality_errors.json").write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding="utf-8")
    raise RuntimeError("央视高清源暂时无法完整下载，未发送低清文件")


def _run_cctv_resumable(command: list[str], folder: Path, settings: Settings) -> None:
    deadline = time.monotonic() + settings.video_url_download_timeout_seconds
    attempts = []
    for attempt in range(3):
        remaining = int(deadline - time.monotonic())
        if remaining <= 0:
            break
        try:
            result = _run(command, min(90, remaining))
            (folder / "download.jsonl").write_text(result.stdout, encoding="utf-8")
            return
        except Exception as exc:
            attempts.append(str(exc))
            # The child has exited before any shard or state file is touched.
            repaired = _recover_cctv_shards(folder, settings, deadline)
            attempts.append(f"Recovered shards: {repaired}")
            (folder / "recovery.json").write_text(json.dumps(attempts, ensure_ascii=False, indent=2), encoding="utf-8")
            command = command.copy()
            command[command.index("--threads") + 1] = "2"
    raise RuntimeError("央视分片恢复仍未完成；保留已下载分片：" + str(folder))


def _recover_cctv_shards(folder: Path, settings: Settings, deadline: float) -> int:
    repaired = 0
    for state_path in folder.rglob(".download_state.json"):
        state = json.loads(state_path.read_text(encoding="utf-8"))
        urls = state.get("urls") or []
        completed = set(state.get("completed_indexes") or [])
        for index in range(1, len(urls) + 1):
            if time.monotonic() >= deadline:
                break
            url = urls[index - 1]
            name = Path(urlsplit(url).path).name
            if not re.fullmatch(r"\d+\.ts", name):
                continue
            final = state_path.parent / name
            if index in completed and final.is_file() and final.stat().st_size > 0:
                continue
            temporary = final.with_suffix(".ts.recovering")
            command = ["curl.exe", "--fail", "--location", "--connect-timeout", "10",
                       "--max-time", "25", "--retry", "1", "--retry-all-errors", "--output", str(temporary)]
            if settings.proxy:
                command += ["--proxy", settings.proxy]
            try:
                _run(command + [url], max(1, min(55, int(deadline - time.monotonic()))))
                size = temporary.stat().st_size
                with temporary.open("rb") as content:
                    sync = content.read(1)
                if size == 0 or size % 188 or sync != b"G":
                    raise RuntimeError("Invalid transport stream shard")
                temporary.replace(final)
                completed.add(index)
                repaired += 1
                state["completed_indexes"] = sorted(completed)
                state["pending_indexes"] = sorted(set(range(1, len(urls) + 1)) - completed)
                staged = state_path.with_suffix(".json.tmp")
                staged.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
                staged.replace(state_path)
            except Exception:
                continue
    return repaired


def _validate_cctv_file(path: Path, height: int, settings: Settings) -> None:
    probe = json.loads(_run([
        "ffprobe.exe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=height", "-of", "json", str(path)
    ], 30).stdout)
    actual = int((probe.get("streams") or [{}])[0].get("height") or 0)
    if actual < height:
        raise RuntimeError(f"清晰度不符：列表 {height}p，实际 {actual}p")
    _run(["ffmpeg.exe", "-v", "error", "-xerror", "-i", str(path),
          "-f", "null", "-"], settings.video_url_download_timeout_seconds)


def _cctv_variants(playlist: str, source: str) -> list[tuple[int, int, str]]:
    variants = []
    quality = None
    for line in playlist.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-STREAM-INF:"):
            resolution = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
            bandwidth = re.search(r"(?:[:,\s])BANDWIDTH=(\d+)", line)
            quality = (int(resolution.group(2)) if resolution else 0,
                       int(bandwidth.group(1)) if bandwidth else 0)
        elif line and not line.startswith("#") and quality is not None:
            variants.append((*quality, urljoin(source, line)))
            quality = None
    return variants


def _download_with_ytdlp(url: str, download_dir: Path, settings: Settings) -> Path:
    output_template = str(download_dir / "%(title).120s-%(id)s.%(ext)s")
    host = (urlsplit(url).hostname or "").lower()
    sort_order = "res,fps,tbr,filesize"
    format_selector = "bv*+ba/best"
    command = [
        settings.ytdlp_cli,
        "--no-playlist",
        "--ignore-config",
        "--socket-timeout", "25",
        "--retries", "2",
        "--concurrent-fragments", "4",
        "--restrict-filenames",
        "--merge-output-format",
        "mp4",
        "-f",
        format_selector,
        "-S",
        sort_order,
        "--abort-on-unavailable-fragments",
        "--fragment-retries", "2",
        "-o",
        output_template,
        "--print",
        "after_move:filepath",
    ]
    cookies_file = str(settings.ytdlp_cookies_file or "").strip()
    if settings.proxy:
        command += ["--proxy", settings.proxy]
    if urlsplit(url).path.endswith(".m3u8"):
        command.append("--force-generic-extractor")
    if cookies_file:
        command += ["--cookies", cookies_file]
    elif settings.ytdlp_cookies_from_browser:
        command += ["--cookies-from-browser", settings.ytdlp_cookies_from_browser]
    metadata_command = command + ["--skip-download", "--dump-single-json", "--no-warnings", url]
    print_index = metadata_command.index("--print")
    del metadata_command[print_index:print_index + 2]
    info = json.loads(_run(metadata_command, settings.video_url_download_timeout_seconds).stdout)
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        raise RuntimeError("此入口仅下载已发布视频，不录制直播")
    if info.get("_type") in {"playlist", "multi_video"}:
        raise RuntimeError("请提供单个视频链接，不批量下载播放列表")
    formats = [f for f in info.get("formats", []) if f.get("vcodec") != "none" and f.get("height") and not f.get("has_drm")]
    if not formats:
        raise RuntimeError("无法确认视频的最高画质，未选择未知清晰度下载")
    def rank(item):
        return (int(item.get("height") or 0), float(item.get("tbr") or item.get("vbr") or 0), float(item.get("fps") or 0))
    best_rank = max(map(rank, formats))
    candidates = [f for f in formats if rank(f) == best_rank]
    if host == "v.qq.com":
        candidates.sort(key=lambda f: (not str(f['format_id']).endswith('-0'), str(f['format_id'])))
    errors = []
    for index, candidate in enumerate(candidates):
        attempt = command.copy()
        selector = str(candidate["format_id"])
        if candidate.get("acodec") == "none":
            selector += "+bestaudio"
        attempt[attempt.index("-f") + 1] = selector
        folder = download_dir / f"format_{index}"
        folder.mkdir(parents=True, exist_ok=True)
        attempt[attempt.index("-o") + 1] = str(folder / "%(id)s.%(ext)s")
        try:
            proc = _run(attempt + [url], settings.video_url_download_timeout_seconds)
            paths = [Path(line.strip()) for line in proc.stdout.splitlines() if line.strip()]
            path = next((p for p in reversed(paths) if p.is_file() and p.suffix.lower() in VIDEO_SUFFIXES), None)
            if path is None:
                raise RuntimeError("下载器未返回完整文件")
            _validate_cctv_file(path, best_rank[0], settings)
            _record_quality(path, url, selector, best_rank[0], info.get("duration"))
            final = download_dir / f"{_safe_stem(info.get('title') or info.get('id') or 'video')}-{_safe_stem(str(info.get('id') or 'video'))}{path.suffix}"
            path.replace(final)
            path.with_suffix('.quality.json').replace(final.with_suffix('.quality.json'))
            return final.resolve()
        except Exception as exc:
            errors.append(str(exc))
    raise RuntimeError("最高画质下载失败，未降档：" + "\n".join(errors)[-1200:])


def _record_quality(path: Path, url: str, source: str, expected_height: int, expected_duration=None) -> None:
    metadata = json.loads(_run(["ffprobe.exe", "-v", "error", "-show_entries",
        "stream=codec_type,width,height,bit_rate:format=duration,size,bit_rate", "-of", "json", str(path)], 30).stdout)
    duration = float((metadata.get("format") or {}).get("duration") or 0)
    if expected_duration and abs(duration - float(expected_duration)) > max(3, float(expected_duration) * 0.01):
        raise RuntimeError("下载文件时长与原视频不符")
    metadata.update(page_url=url, selected_source=source, expected_height=expected_height)
    path.with_suffix(".quality.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def _download_with_sohu(url: str, download_dir: Path, settings: Settings) -> Path:
    host = (urlsplit(url).hostname or "").lower()
    if host != "sohu.com" and not host.endswith(".sohu.com"):
        raise RuntimeError("not a Sohu URL")
    download_dir.mkdir(parents=True, exist_ok=True)

    page = _fetch_text(url)
    vid_match = re.search(r"var\s+vid\s*=\s*['\"]([^'\"]+)['\"]", page)
    title_match = re.search(r"<title>(.*?)</title>", page, re.IGNORECASE | re.DOTALL)
    if not vid_match:
        decoded = _try_decode_sohu_path(url)
        if decoded:
            page = _fetch_text(f"https://my.tv.sohu.com/{decoded}")
            vid_match = re.search(r"var\s+vid\s*=\s*['\"]([^'\"]+)['\"]", page)
            title_match = re.search(r"<title>(.*?)</title>", page, re.IGNORECASE | re.DOTALL)
    if not vid_match:
        raise RuntimeError("Sohu page did not expose vid")

    base_vid = vid_match.group(1)
    candidate_ids = [base_vid, f"{base_vid}_1", f"{base_vid}_21", f"{base_vid}_31"]
    best: dict | None = None
    for video_id in candidate_ids:
        try:
            payload = json.loads(_fetch_text(f"https://my.tv.sohu.com/play/videonew.do?vid={video_id}&referer={url}"))
        except Exception:
            continue
        data = payload.get("data") or {}
        clips = data.get("clipsURL") or data.get("mp4PlayUrl") or []
        if payload.get("status") != 1 or not clips:
            continue
        total_bytes = int(data.get("totalBytes") or sum(int(x or 0) for x in data.get("clipsBytes", []) or []))
        try:
            probe = json.loads(_run(["ffprobe.exe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,bit_rate", "-of", "json", str(clips[0])], 30).stdout)
            stream = (probe.get("streams") or [{}])[0]
            height = int(stream.get("height") or 0)
        except Exception as exc:
            raise RuntimeError("搜狐候选画质读取失败，无法确认最高画质") from exc
        item = {"id": video_id, "data": data, "clips": clips, "bytes": total_bytes, "height": height}
        if not best or (height, total_bytes) > (best["height"], best["bytes"]):
            best = item

    if not best:
        raise RuntimeError("Sohu API did not return playable clips")

    data = best["data"]
    title = str(data.get("tvName") or (title_match.group(1).strip() if title_match else best["id"]))
    stem = _safe_stem(title)
    clips = list(best["clips"])
    part_paths: list[Path] = []
    for index, clip_url in enumerate(clips, start=1):
        part_path = download_dir / f"{stem}.part{index}.mp4"
        _download_url(str(clip_url), part_path, settings.video_url_download_timeout_seconds)
        part_paths.append(part_path)

    final_path = download_dir / f"{stem}-{best['id']}.mp4"
    if final_path.exists():
        final_path.unlink()
    if len(part_paths) == 1:
        part_paths[0].rename(final_path)
        _validate_cctv_file(final_path, best['height'], settings)
        _record_quality(final_path, url, str(best['id']), best['height'])
        return final_path.resolve()

    list_path = download_dir / f"{stem}.concat.txt"
    list_path.write_text("".join(f"file '{path.as_posix()}'\n" for path in part_paths), encoding="utf-8")
    _run(["ffmpeg.exe", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(final_path)], settings.video_url_download_timeout_seconds)
    _validate_cctv_file(final_path, best['height'], settings)
    _record_quality(final_path, url, str(best['id']), best['height'])
    return final_path.resolve()


def _download_url(url: str, output_path: Path, timeout: int) -> None:
    _run(["curl.exe", "-L", "--fail", "--retry", "2", "-o", str(output_path), url], timeout)


def _fetch_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36",
            "Referer": url,
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read()
    for encoding in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _try_decode_sohu_path(url: str) -> str | None:
    match = re.search(r"/v/([^/?#]+)\.html", url)
    if not match:
        return None
    try:
        token = match.group(1)
        padded = token + "=" * (-len(token) % 4)
        return base64.b64decode(padded).decode("utf-8", errors="replace").lstrip("/")
    except Exception:
        return None


def _run(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    command = command.copy()
    if command[0] == "yt-dlp":
        command[:1] = [sys.executable, "-m", "yt_dlp"]
    elif command[0] in {"ffmpeg.exe", "ffprobe.exe", "curl.exe"}:
        command[0] = shutil.which(command[0]) or shutil.which(command[0][:-4]) or command[0]
    child = subprocess.Popen(
        command,
        cwd=PROJECT_ROOT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONUTF8": "1"},
        start_new_session=os.name != "nt",
    )
    try:
        stdout, stderr = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"], capture_output=True)
        else:
            os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise RuntimeError(f"下载进程超过 {timeout} 秒，已停止")
    proc = subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
    if proc.returncode != 0:
        detail = "\n".join(part.strip() for part in [proc.stdout, proc.stderr] if part and part.strip())
        raise RuntimeError(detail[-1200:] or f"{command[0]} exited with {proc.returncode}")
    return proc


def _latest_video(download_dir: Path) -> Path:
    candidates = [
        path
        for path in download_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES and path.stat().st_size > 0
        and not re.search(r"(?:\.part\d*|\.f\d+)\.", path.name)
    ]
    if not candidates:
        raise RuntimeError(f"下载目录里没有找到视频文件：{download_dir}")
    return max(candidates, key=lambda path: path.stat().st_mtime).resolve()


def _safe_stem(value: str) -> str:
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", value or "message").strip("._ ")
    return stem[:80] or "message"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Download the highest available video quality locally")
    parser.add_argument("url")
    parser.add_argument("--output", type=Path, default=Path.cwd() / "downloads")
    parser.add_argument("--cookies", default="")
    parser.add_argument("--cookies-from-browser", default="")
    parser.add_argument("--proxy", default="")
    parser.add_argument("--cctv-cli", default="")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--list-formats", action="store_true")
    args = parser.parse_args()
    DOWNLOAD_ROOT = args.output.resolve()
    config = Settings(video_url_download_timeout_seconds=args.timeout,
        ytdlp_cookies_file=args.cookies, ytdlp_cookies_from_browser=args.cookies_from_browser,
        proxy=args.proxy, cctv_cli=args.cctv_cli)
    if args.proxy:
        os.environ["HTTPS_PROXY"] = args.proxy
        os.environ["HTTP_PROXY"] = args.proxy
    try:
        url = extract_first_url(args.url)
        if not url:
            raise ValueError("请输入 HTTP(S) 视频链接")
        if args.list_formats:
            command = ["yt-dlp", "--ignore-config", "--no-playlist", "--socket-timeout", "25", "--retries", "1", "-F"]
            if args.cookies:
                command += ["--cookies", args.cookies]
            elif args.cookies_from_browser:
                command += ["--cookies-from-browser", args.cookies_from_browser]
            if args.proxy:
                command += ["--proxy", args.proxy]
            print(_run(command + [url], args.timeout).stdout)
        else:
            result = _download_video_sync(url, "local", config)
            print(json.dumps({"ok": True, "path": str(result), "quality_report": str(result.with_suffix('.quality.json'))}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
