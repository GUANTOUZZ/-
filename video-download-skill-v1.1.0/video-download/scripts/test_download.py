import tempfile
import unittest
import json
import time
from unittest.mock import patch
from pathlib import Path

import download


class DownloadTests(unittest.TestCase):
    def test_repair_only_missing_shard(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            first = b'G' + b'\x00' * 187
            (folder / '0.ts').write_bytes(first)
            state_file = folder / '.download_state.json'
            state_file.write_text(json.dumps({'urls': ['https://example.com/0.ts', 'https://example.com/1.ts'], 'completed_indexes': [1], 'pending_indexes': [2]}))
            def retrieve(command, timeout):
                self.assertEqual(command[-1], 'https://example.com/1.ts')
                Path(command[command.index('--output') + 1]).write_bytes(first)
            with patch.object(download, '_run', side_effect=retrieve) as runner:
                self.assertEqual(download._recover_cctv_shards(folder, download.Settings(), time.monotonic() + 30), 1)
                self.assertEqual(runner.call_count, 1)
            self.assertEqual(json.loads(state_file.read_text())['completed_indexes'], [1, 2])
            self.assertEqual((folder / '0.ts').read_bytes(), first)

    def test_bad_shard_is_not_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            state_file = folder / '.download_state.json'
            state_file.write_text(json.dumps({'urls': ['https://example.com/0.ts'], 'completed_indexes': [], 'pending_indexes': [1]}))
            def retrieve(command, timeout):
                Path(command[command.index('--output') + 1]).write_bytes(b'<html>error</html>')
            with patch.object(download, '_run', side_effect=retrieve):
                self.assertEqual(download._recover_cctv_shards(folder, download.Settings(), time.monotonic() + 30), 0)
            self.assertFalse((folder / '0.ts').exists())
            self.assertEqual(json.loads(state_file.read_text())['completed_indexes'], [])

    def test_share_text(self):
        self.assertEqual(download.extract_first_url("https://v.qq.com/x/a.html下载"), "https://v.qq.com/x/a.html")
        self.assertEqual(download.extract_first_url("看 https://a.com/a.mp4?token=x%2Fy&x=2"), "https://a.com/a.mp4?token=x%2Fy&x=2")

    def test_master_playlist(self):
        playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n/high.m3u8\n'
        variants = download._cctv_variants(playlist, 'https://a.com/path/main.m3u8')
        self.assertEqual(max(variants), (720, 2000000, 'https://a.com/high.m3u8'))

    def test_no_partial_delivery(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'video.part1.mp4').write_bytes(b'partial')
            (root / 'video.mp4.part').write_bytes(b'partial')
            with self.assertRaises(RuntimeError):
                download._latest_video(root)
            final = root / 'complete.mp4'
            final.write_bytes(b'complete')
            self.assertEqual(download._latest_video(root), final.resolve())


if __name__ == '__main__':
    unittest.main()
