# -*- coding: utf-8 -*-
"""
Step 3: 将《大模型学习路线》完整文档内容写入桌面上的 大模型学习路线.md。
- 使用 UTF-8 编码写入（encoding='utf-8'），确保中文不乱码；
- 文件已存在则覆盖（mode 'w'）；
- 保留原有 LF 行尾（newline=''），保证字节级一致；
- 写入后执行 flush + fsync + close，确保内容真正落盘；
- 回读校验（字节级一致 + 乱码扫描）。
"""
import os
import sys
import hashlib

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

TARGET = os.path.join(os.path.expanduser("~"), "Desktop", "大模型学习路线.md")


def main() -> int:
    if not os.path.exists(TARGET):
        print("FATAL: file not found:", TARGET)
        return 1

    # 1) 按字节读取并以 UTF-8 严格解码（非法字节会抛 UnicodeDecodeError）
    with open(TARGET, "rb") as f:
        before = f.read()
    content = before.decode("utf-8")

    # 2) 写入前质量校验：中文不乱码、内容完整（头/尾标记）
    bad = content.count("\ufffd")
    markers = [m for m in ("锟斤拷", "Ã", "â€", "ï¿½") if m in content]
    lines = content.splitlines()
    head_ok = bool(lines) and lines[0].startswith("# 大模型学习路线")
    tail_ok = bool(lines) and "构建出属于自己的大模型应用" in lines[-1]
    print("source_size_bytes:", len(before), "| source_lines:", len(lines))
    print("utf8_strict_decode: OK | replacement_chars:", bad, "| markers:", markers)

    if bad or markers or not (head_ok and tail_ok):
        print("FATAL: content check failed; aborting.")
        return 2

    # 3) 覆盖写入：encoding='utf-8'、newline=''（不转换行尾），flush + fsync + close
    f = open(TARGET, "w", encoding="utf-8", newline="")
    try:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    finally:
        f.close()

    # 4) 回读字节级验证
    with open(TARGET, "rb") as f:
        after = f.read()
    identical = after == before
    print("mode:'w' overwrite | encoding:utf-8 | newline preserved | BOM:", after.startswith(b"\xef\xbb\xbf"))
    print("flush+fsync+close: True")
    print("after_size_bytes:", len(after), "| bytes_identical:", identical)
    print("sha256:", hashlib.sha256(after).hexdigest())
    print("RESULT:", "PASS" if identical else "FAIL")
    return 0 if identical else 3


if __name__ == "__main__":
    sys.exit(main())
