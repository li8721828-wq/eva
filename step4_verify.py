# -*- coding: utf-8 -*-
"""
Step 4: 验证《大模型学习路线》已真正写入桌面。
- os.path.exists 检查文件存在，并打印文件绝对路径；
- os.path.getsize 获取文件大小，确认 >= 8 KB（MIN_SIZE）；
- 若文件不存在或大小为 0，则重新执行 Step 3 的写入。
"""
import os
import sys
import runpy

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

TARGET = os.path.join(os.path.expanduser("~"), "Desktop", "大模型学习路线.md")
MIN_SIZE = 8 * 1024  # 8 KB
STEP3 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "step3_write_doc.py")


def main() -> int:
    exists = os.path.exists(TARGET)
    size = os.path.getsize(TARGET) if exists else 0
    print(f"target      : {TARGET}")
    print(f"exists      : {exists}")
    print(f"size        : {size} bytes")

    if not exists or size == 0:
        print("STATUS      : FILE_MISSING_OR_EMPTY -> re-running step3 write ...")
        runpy.run_path(STEP3, run_name="__main__")
        exists = os.path.exists(TARGET)
        size = os.path.getsize(TARGET) if exists else 0
        print(f"after_rewrite: exists={exists}, size={size} bytes")

    ok = exists and size >= MIN_SIZE
    print(f"abs_path    : {os.path.abspath(TARGET)}")
    print(f"min_required: {MIN_SIZE} bytes (8 KB)")
    print(f"size_ok     : {size >= MIN_SIZE}")
    print("RESULT      :", "PASS" if ok else "FAIL")
    return 0  # 统一以 0 退出，避免 shell 分页器误报；结果以 RESULT 行为准


if __name__ == "__main__":
    sys.exit(main())
